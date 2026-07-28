#!/usr/bin/env python3
"""Deep-merge the repo's ``agent_home/config.yaml`` onto the claw's live
``config.yaml`` (fetched by the manage skill's Merge-config mode).

Semantics
---------
The **live (remote) config is the base**; the **local (curated) config is
overlaid on top, key by key (deep)**. Local wins on overlapping leaf keys. The
remote document is loaded with ruamel.yaml **round-trip** mode so the live
config's comments and key order are preserved on every key we do not touch —
only the curated overrides land, nothing else moves.

Classification (so the caller can ask the user before applying anything risky)
---------
For every difference we record one of:

  * ``added``        — key only in local → applied (additive, safe).
  * ``overridden``   — leaf differs, and the local file is at least as new as
                       the remote file → local applied silently (curated intent
                       is the newer edit). Reported, not blocking.
  * ``ask``          — needs human confirmation before it sticks:
                       - ``type_mismatch``      mapping vs scalar at the same path
                       - ``override_remote_newer`` the live config.yaml was
                              modified AFTER the local edit (remote mtime > local)
                       - ``override_unreliable_mtime`` mtimes are missing or the
                              remote clock looks skewed, so "who's newer" can't be
                              trusted
                       The merged output still stages local-wins for these (so a
                       single ``--keep-remote`` re-run is all that's needed to
                       flip any of them back to the remote value); the report just
                       flags them so the operator can confirm or override.
  * ``kept_remote``  — a path passed via ``--keep-remote``; remote value kept.

The script NEVER deletes keys and NEVER raises on a content difference — a bad
override is reported, not silently applied.

Exit codes: 0 = merged output written (inspect the report for ``ask`` items);
            2 = could not merge (missing/unreadable input, parse error).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone

from ruamel.yaml import YAML

# An mtime before 2000-01-01 is treated as bogus (missing file / unset).
_MIN_SANE_EPOCH = 946684800
# How far into the "future" the remote mtime may be before we call clock skew.
_DEFAULT_FUTURE_TOLERANCE = 120


def _load(path: str):
    yaml = YAML(typ="rt")  # round-trip: preserve comments + order
    yaml.preserve_quotes = True
    with open(path, "r", encoding="utf-8") as fh:
        return yaml.load(fh)


def _empty_mapping():
    yaml = YAML(typ="rt")
    return yaml.map()


def _is_mapping(node) -> bool:
    return isinstance(node, dict)


def _scalar_eq(a, b) -> bool:
    try:
        return bool(a == b)
    except Exception:  # ruamel scalar comparison should not raise, but be safe
        return False


def _fmt(value) -> str:
    """One-line, length-bounded rendering of a value for the human report."""
    if _is_mapping(value):
        return "<mapping, %d keys>" % len(value)
    if isinstance(value, (list, tuple)):
        return "<list, %d items>" % len(value)
    s = str(value)
    s = s.replace("\n", "\\n")
    return s if len(s) <= 80 else s[:77] + "..."


def _mtime(path: str):
    try:
        return int(os.stat(path).st_mtime)
    except OSError:
        return None


def _iso(epoch):
    if not epoch:
        return "unknown"
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds")


def _classify_mtimes(local_mtime, remote_mtime, now, future_tol):
    """Decide whether per-override 'remote is newer' detection is trustworthy."""
    if local_mtime is None or remote_mtime is None:
        return False, "missing mtime (local or remote not captured)"
    if remote_mtime < _MIN_SANE_EPOCH or local_mtime < _MIN_SANE_EPOCH:
        return False, "mtime looks bogus (before year 2000)"
    if remote_mtime > now + future_tol:
        return False, "remote mtime is in the future (clock skew)"
    return True, None


def _override_flag(mtimes_reliable, local_mtime, remote_mtime) -> str:
    """Verdict for a leaf override. Same for every override (file-level mtimes)."""
    if not mtimes_reliable:
        return "override_unreliable_mtime"
    if remote_mtime > local_mtime:
        return "override_remote_newer"
    return "apply"  # local is newer or equal → curated edit wins


def _walk(local_node, remote_node, path, ctx, report):
    """Overlay local onto remote in place, classifying each change."""
    for key in list(local_node.keys()):
        seg = path + [str(key)]
        ps = ".".join(seg)
        lv = local_node[key]

        # --keep-remote short-circuits a leaf OR a whole subtree.
        if ps in ctx["keep_remote"]:
            report["kept_remote"].append(ps)
            continue

        if key not in remote_node:
            remote_node[key] = lv  # alias is fine: we never mutate local after load
            report["added"].append(ps)
            continue

        rv = remote_node[key]
        l_map, r_map = _is_mapping(lv), _is_mapping(rv)

        if l_map and r_map:
            _walk(lv, rv, seg, ctx, report)
        elif l_map != r_map:
            # mapping vs scalar/list at the same path — stage local-wins but
            # flag, so a --keep-remote re-run flips it back to remote.
            remote_node[key] = lv
            report["ask"].append(("type_mismatch", ps, rv, lv))
        else:
            if _scalar_eq(rv, lv):
                continue
            flag = _override_flag(
                ctx["mtimes_reliable"], ctx["local_mtime"], ctx["remote_mtime"]
            )
            remote_node[key] = lv
            if flag == "apply":
                report["overridden"].append((ps, rv, lv))
            else:
                report["ask"].append((flag, ps, rv, lv))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--local", required=True, help="curated agent_home/config.yaml")
    p.add_argument("--remote", required=True, help="fetched live config.yaml")
    p.add_argument("--out", required=True, help="path to write the merged result")
    p.add_argument("--remote-mtime", type=int, default=None,
                   help="epoch mtime of the LIVE config.yaml (capture on the container)")
    p.add_argument("--keep-remote", action="append", default=[], metavar="DOTTED.PATH",
                   help="keep the remote value for this key/subtree (repeatable); "
                        "use to honor a flagged conflict's remote side")
    p.add_argument("--future-tolerance", type=int, default=_DEFAULT_FUTURE_TOLERANCE,
                   help="seconds the remote mtime may exceed 'now' before flagging skew")
    p.add_argument("--now", type=int, default=None, help="override 'now' (testing)")
    args = p.parse_args(argv)

    for label, path in (("local", args.local), ("remote", args.remote)):
        if not os.path.exists(path):
            print("merge-config: %s file not found: %s" % (label, path), file=sys.stderr)
            return 2

    try:
        local = _load(args.local)
    except Exception as exc:
        print("merge-config: cannot parse local %s: %s" % (args.local, exc), file=sys.stderr)
        return 2
    if local is None:
        local = _empty_mapping()
    if not _is_mapping(local):
        print("merge-config: local config top level is not a mapping; aborting.", file=sys.stderr)
        return 2

    remote_absent = False
    try:
        remote = _load(args.remote)
    except Exception as exc:
        print("merge-config: cannot parse remote %s: %s" % (args.remote, exc), file=sys.stderr)
        return 2
    if remote is None:
        remote_absent = True
        remote = _empty_mapping()
    if not _is_mapping(remote):
        print("merge-config: remote config top level is not a mapping; aborting.", file=sys.stderr)
        return 2

    local_mtime = _mtime(args.local)
    now = args.now or int(time.time())
    mtimes_reliable, skew_reason = _classify_mtimes(
        local_mtime, args.remote_mtime, now, args.future_tolerance
    )
    if remote_absent:
        mtimes_reliable = False
        skew_reason = "remote config absent on the claw (nothing to merge onto)"

    ctx = {
        "keep_remote": set(args.keep_remote),
        "mtimes_reliable": mtimes_reliable,
        "local_mtime": local_mtime,
        "remote_mtime": args.remote_mtime,
    }
    report = {"added": [], "overridden": [], "ask": [], "kept_remote": []}
    _walk(local, remote, [], ctx, report)

    out_yaml = YAML(typ="rt")
    out_yaml.preserve_quotes = True
    out_yaml.width = 1000  # avoid line-folding scalars
    out_yaml.indent(mapping=2, sequence=4, offset=2)
    with open(args.out, "w", encoding="utf-8") as fh:
        out_yaml.dump(remote, fh)

    _print_report(args, report, local_mtime, args.remote_mtime, mtimes_reliable, skew_reason, now)
    needs_confirm = bool(report["ask"])
    print("NEEDS_CONFIRM: %s" % ("yes" if needs_confirm else "no"))
    print("MERGED_WRITTEN: %s" % args.out)
    return 0


def _print_report(args, report, local_mtime, remote_mtime, reliable, reason, now):
    print("=== merge-config report ===")
    print("local:  %s" % args.local)
    print("        mtime %s (epoch %s)" % (_iso(local_mtime), local_mtime))
    print("remote: %s" % args.remote)
    print("        mtime %s (epoch %s)" % (_iso(remote_mtime), remote_mtime))
    if reliable:
        if remote_mtime is not None and local_mtime is not None and remote_mtime > local_mtime:
            print("mtimes: RELIABLE — remote config is NEWER than local "
                  "(overrides will be flagged for confirmation)")
        else:
            print("mtimes: RELIABLE — local is at least as new as remote "
                  "(local wins on overrides, not flagged)")
    else:
        print("mtimes: UNRELIABLE — %s (overrides will be flagged)" % (reason or "unknown"))

    def _section(title, items, fmt):
        print("\n%s (%d):" % (title, len(items)))
        if not items:
            print("  (none)")
            return
        for it in items:
            print("  " + fmt(it))

    _section("added (local-only — applied)", report["added"], lambda s: s)
    _section(
        "overridden (local wins — not flagged)",
        report["overridden"],
        lambda t: "%s:  %s  ->  %s" % (t[0], _fmt(t[1]), _fmt(t[2])),
    )
    _section(
        "FLAGGED — confirm before applying (staged as local-wins; flip with --keep-remote)",
        report["ask"],
        lambda t: "[%s] %s:  %s  ->  %s" % (t[0], t[1], _fmt(t[2]), _fmt(t[3])),
    )
    _section(
        "kept-remote (--keep-remote — remote value preserved)",
        report["kept_remote"],
        lambda s: s,
    )


if __name__ == "__main__":
    raise SystemExit(main())
