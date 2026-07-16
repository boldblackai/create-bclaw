# On-boot materialization of `_`-prefixed SSM secrets into `$HERMES_HOME/.env`

**Date:** 2026-07-16
**Status:** Proposed

## Goal

Let the operator forward arbitrary extra environment variables into the running
claw **without editing `template.yaml`, redeploying the stack, or routing
secret plaintext through the deployer shell or the agent's context**. Any SSM
SecureString under `/bclaw/` whose leaf name starts with `_`
(e.g. `/bclaw/_MY_API_KEY`) is, on every container boot, fetched **inside the
container** (using the task role), decrypted, and written as `KEY=value` lines
into `$HERMES_HOME/.env` (`/home/harness/.hermes/.env`, EBS-backed). Hermes'
own env loader already sources that file on gateway start, so the values appear
in the gateway's environment with no task-definition `secrets[]` entry, no
per-secret CloudFormation round-trip, and no plaintext ever leaving the
AWS→container data plane. Editing an SSM param and restarting the task
auto-rotates the value.

## Dependencies

- **`ghcr.io/boldblackai/harness` must ship the `aws` CLI.** This design runs
  `aws ssm` **inside the container** (the whole point — it keeps secret
  plaintext off the deployer host and out of the agent's context). The harness
  image **does not ship `aws` today** — it ships `gh` and `hermes`, but not
  `aws` (every `aws` call in the shipped skills runs on the deployer host or
  the EC2 container instance, never inside the container). Until `aws` is added
  to the image, this RFC **cannot land**: the boot `Command` guards on
  `command -v aws`, so the feature would silently no-op (non-fatal, but inert)
  on every claw. Adding `aws` to the harness image is a **blocking upstream
  prerequisite**, tracked as the first implementation-checklist item. If
  shipping `aws` proves undesirable, the fallbacks are evaluated in
  Alternatives (none chosen); the in-image-`aws` path is the preferred
  resolution.

## Motivation

Today there are exactly two ways to get a secret into the container env, both
documented under setup-bclaw → Notes → "Adding new SSM secrets":

1. **Unconditional** — add a plain entry to the task def `secrets[]` (the 4
   Slack secrets). The task fails to start if the param is missing.
2. **Opt-in conditional** — add an `Enable*Key` stack parameter + a
   `Conditions` entry + a `!If` entry in `secrets[]` (the provider keys,
   `GH_TOKEN_VAL`). Three coordinated template edits per secret, plus a
   `cloudformation deploy`.

Both require a `template.yaml` edit and a stack redeploy for **every** new
secret. That is the right bar for secrets the **template** owns (Slack, the
provider model keys) — those are part of the product and belong in version
control. But operators routinely need **one-off, claw-specific** env vars that
are not part of the shipped product: a webhook signing secret, a third-party
API key for a single integration, a feature-flag token. Forcing a template
edit + redeploy for each is heavyweight, and it tempts operators to commit
claw-specific secrets into the shared `template.yaml` (which ships to every
generated claw).

The `_`-prefix convention carves out a **template-free escape hatch**: anything
the operator drops into SSM as `/bclaw/_*` is forwarded to the gateway's env
with no template touch and no redeploy. It mirrors how a developer configures a
local hermes install — by putting keys in `~/.hermes/.env` — and reuses the
exact same loader (`env_loader.load_hermes_dotenv`) hermes already runs.

### Why on-boot, in-container (not deployer-side)

Earlier drafts materialized `.env` from the **deployer shell** during
`setup-bclaw`. That design was rejected because it routes secret plaintext
through the deployer host **and the agent's own context**: the decrypt step
(`aws ssm get-parameters --with-decryption --query '...Value]'`) prints values
to stdout that the agent captures; rendering the `.env` "locally" holds the
plaintext; and the proven `manage-bclaw` transfer transport does
`CHUNK=$(cat "$f")` + embeds it in `--command`, so the base64 of a
secret-laden `.env` would flow through the agent's tool calls. Decoding base64
is trivial, so that is plaintext-in-context in practice.

Doing the fetch **inside the container under the task role** removes that
exposure entirely: the `aws ssm` calls run in the container's session, the
plaintext is written straight to `$HERMES_HOME/.env`, and the deployer shell +
agent context only ever see exit codes. As a bonus, running it on **every
boot** makes rotation automatic (SSM edit + task restart) instead of an
operator-triggered refresh step.

## Background: the facts that make this cheap

1. **Hermes already sources `~/.hermes/.env`.** The gateway's
   `env_loader.load_hermes_dotenv` resolves `$HERMES_HOME/.env` on start and
   merges it into the process environment (documented under Hermes →
   Environment Variables: "for user-managed secrets, from `~/.hermes/.env`").
   `$HERMES_HOME` is `/home/harness/.hermes` in the container, which is the
   EBS-backed bind-mount. No new reader, no entrypoint change beyond appending
   one step to the existing `Command` before `exec hermes gateway`.

2. **The container process runs under the task role.** The `secrets[]`
   resolution at task start is done by the ECS **agent** under the *execution*
   role; the running container's own AWS calls use the **task** role
   (`${ClawName}-task`). Today the task role only carries `ssmmessages:*` (for
   ECS Exec). Adding a scoped SSM+KMS grant to the task role is what lets the
   container fetch `/bclaw/_*` itself — keeping plaintext off the deployer
   host.

3. **The `/bclaw/` namespace is hardcoded, not `ClawName`-derived.** That is
   what lets IAM pin `parameter/bclaw/*` and lets the boot script hardcode the
   `/bclaw` path rather than derive it from the claw name.

4. **The container can already see every `/bclaw/*` value.** Every `secrets[]`
   entry is injected into the container env at start, so the container already
   holds the Slack tokens, the provider key, and `GH_TOKEN_VAL` in memory.
   Granting the task role `ssm:GetParameter` on `parameter/bclaw/*` therefore
   adds the *ability to re-read/rotate-fetch* params at runtime, not a new
   *exposure class* of values the container couldn't otherwise see. The only
   genuinely new read capability is `/bclaw/_*` (the convention params) — which
   is the whole point.

## Naming convention

- The leading `_` on the **leaf** segment is the "forward to `.env`" routing
  signal. `/bclaw/_MY_API_KEY` → the env var **`MY_API_KEY`** (the `_` is
  stripped; it is not part of the exported name).
- Only direct children of `/bclaw/` participate:
  `/bclaw/_FOO` ✓, `/bclaw/sub/_BAR` ✗ (the path filter is `/bclaw`
  non-recursive, so deeper nesting is ignored by design — keep it flat).
- The stripped name must be a valid POSIX env-var identifier
  (`[A-Z_][A-Z0-9_]*`). The boot script validates this and skips (with a
  CloudWatch warning) any param that violates it, e.g. `/bclaw/_123BAD` or
  `/bclaw/_bad-name`.
- **Opt-in and additive:** it never touches the existing `secrets[]` entries
  (Slack, provider keys, `GH_TOKEN_VAL`). Those stay template-owned. A param
  named `/bclaw/OPENROUTER_API_KEY` (no `_`) is still injected the template way;
  a param named `/bclaw/_OPENROUTER_API_KEY` would *additionally* land in
  `.env`. The recommendation is to use `_`-prefix only for secrets the template
  does not own.

## Technical Details

### Task-role IAM grant (`template.yaml`)

Add an inline policy to `TaskRole` (`${ClawName}-task`), mirroring the shape of
the execution role's existing `read-ssm-params` policy but adding the
list/enumerate action and `kms:Decrypt` so the container can resolve the
SecureStrings itself:

```yaml
Policies:
  - PolicyName: materialize-env-secrets
    PolicyDocument:
      Version: "2012-10-17"
      Statement:
        # Read values — tightly scoped to the claw's param prefix.
        - Effect: Allow
          Action:
            - ssm:GetParameters
            - ssm:GetParameter
          Resource: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/bclaw/*"
        # Enumerate names — list-style SSM actions can't be resource-scoped to
        # a single param ARN (they list a hierarchy), so this mirrors the
        # deployer's existing ssm:DescribeParameters grant on "*". Returns
        # metadata only; values come from the scoped GetParameters above.
        - Effect: Allow
          Action: ssm:DescribeParameters
          Resource: "*"
        # Decrypt the SecureStrings with the claw's own CMK (same pin as the
        # execution role: ViaService = ssm.<region>).
        - Effect: Allow
          Action: kms:Decrypt
          Resource: !GetAtt SsmKmsKey.Arn
          Condition:
            StringEquals:
              "kms:ViaService": !Sub "ssm.${AWS::Region}.amazonaws.com"
```

> **Why `DescribeParameters` on `"*"`, not `GetParametersByPath`.**
> `ssm:GetParametersByPath` would be a single call that lists + decrypts in
> one round-trip, but it is also a list-style action that cannot be tightly
> resource-scoped (it needs `Resource: "*"`) — so it offers no IAM-tightness
> advantage over `DescribeParameters`, and `DescribeParameters` is already the
> enumerate pattern the deployer policy uses. The boot script therefore does
> `describe-parameters` (names, filtered to `/bclaw` + leaf-starts-with-`_`)
> then `get-parameters --with-decryption` (values, scoped). The exact tightest
> scope for the list action is confirmed in the integration cycle; the value
> read is unambiguously pinnable to `parameter/bclaw/*`.

### Boot materialization (the container `Command`)

The task definition's `Command` currently runs the optional `gh auth login`
then `exec hermes gateway`. Insert the materialize step **before** `exec hermes
gateway` so hermes' `load_hermes_dotenv` reads the freshly-written file. The
materialize step is **non-fatal**: if SSM is unreachable or a param fails to
resolve, it logs a warning to CloudWatch and the gateway still starts — the
`_`-prefix convention serves operator extras and must never take down the
primary Slack function (same non-fatal posture as the `gh auth` block):

```yaml
Command:
  - sh
  - -c
  - >
    set -e;
    ENV="$HERMES_HOME/.env";
    TMP="$HERMES_HOME/.env.tmp";
    mkdir -p "$HERMES_HOME";
    if command -v aws >/dev/null 2>&1; then
      NAMES=$(aws ssm describe-parameters --region "$AWS_REGION"
        --parameter-filters "Key=Path,Values=/bclaw"
        --query "Parameters[?starts_with(Name, '/bclaw/_')].Name"
        --output text 2>/dev/null | tr '\t' '\n' | sort -u || true);
      : > "$TMP";
      if [ -n "$NAMES" ]; then
        # fetch with decryption in batches of 10 (GetParameters limit),
        # strip the leading '_'/path, validate the identifier, write KEY=value
        echo "$NAMES" | xargs -n10 aws ssm get-parameters --with-decryption
          --region "$AWS_REGION" --query 'Parameters[].[Name,Value]'
          --output text 2>/dev/null \
          | awk -F'\t' '{
              leaf=$1; sub(".*/","",leaf); sub(/^_/,"",leaf);
              if (leaf ~ /^[A-Z_][A-Z0-9_]*$/) print leaf"="$2;
              else print "[env] skipping invalid name: "$1 > "/dev/stderr";
            }' >> "$TMP";
      fi;
      chmod 600 "$TMP"; mv "$TMP" "$ENV";
    else
      echo "[env] aws CLI missing — /bclaw/_* not materialized (non-fatal)";
    fi;
    if [ -n "$GH_TOKEN_VAL" ]; then printf "%s" "$GH_TOKEN_VAL" | gh auth login --with-token 2>&1 || echo "[gh-auth] login failed (non-fatal)"; fi;
    exec hermes gateway
```

(The exact YAML quoting — the `Command` is a single `sh -c` string assembled
from the list — is finalized in the integration cycle; the existing skill
already notes Command-string quoting is finicky. The sketch above conveys the
behavior: enumerate → validate → decrypt → write `.env` mode `0600` →
non-fatal → `exec hermes gateway`.)

### `.env` write semantics: authoritative overwrite

The file is **fully derived from `/bclaw/_*` each boot** — it is rewritten from
scratch on every start, so removing an `_`-prefixed param from SSM drops it
from `.env` on the next restart (auto-cleanup). Consequences:

- `$HERMES_HOME/.env` is **no longer operator-editable inside the container** —
  a hand-edit is overwritten on the next task restart. Operators manage these
  secrets via SSM, not via the container file. This is the correct trade for
  auto-rotation and is documented in setup-bclaw.
- **`hermes config set` interaction (risk, to confirm).** Hermes' own
  `hermes config` writes API keys to `~/.hermes/.env`. If the operator (or the
  agent inside the claw) runs `hermes config set` at runtime, that write would
  be clobbered on the next restart. The integration cycle must confirm whether
  cloud mode (`HARNESS_CLOUD_MODE=1`) treats `.env` as a runtime-writable
  store or as input-only. If it writes `.env` at runtime, the boot script
  switches to **merge** semantics (preserve existing non-`_`-managed keys,
  overwrite only the `/bclaw/_*`-derived ones) rather than overwrite. Until
  confirmed, overwrite is the default for simplicity.

### Rotation lifecycle

Materialization runs on **every boot**, so rotation is: edit the SSM param in
the console (or `put-parameter --overwrite`), then force a new task so the boot
script re-runs:

```bash
aws ecs update-service --cluster "$CLAW_NAME" --service "$CLAW_NAME" \
  --force-new-deployment --region "$AWS_REGION"
```

No `setup-bclaw` re-run, no `manage-bclaw` refresh mode, no redeploy. This is
strictly better than the deployer-side design's manual refresh step.

### setup-bclaw changes

Because the mechanism is self-contained in the stack (task-role grant +
Command), `setup-bclaw` needs only documentation, not a new phase:

- Phase 3 (write SSM secrets) gains a short subsection: "Optional — `_`-prefixed
  operator secrets" explaining the convention (create `/bclaw/_FOO` SecureString
  with `alias/${CLAW_NAME}-ssm`; it materializes into `.env` as `FOO` on the
  next/restart task, no `Enable*Key` parameter).
- Notes gains a bullet describing the convention, the authoritative-overwrite
  `.env` semantics, the non-fatal posture, and the `aws`-CLI dependency (see
  Dependencies).
- No new gate or restart: the first task that starts (Phase 4 scale-to-1) runs
  the materialize step on its own boot, so `_`-prefixed secrets are present
  before the first `exec hermes gateway` — no extra restart beyond the existing
  Phase 4/5 flow.

## Edge cases & risks

- **`aws` CLI in the upstream image — confirmed missing (blocking dependency,
  see Dependencies).** The boot script calls `aws ssm` **inside the
  container**, but the harness image (`ghcr.io/boldblackai/harness`) **does
  not ship `aws` today**. The `Command` guards on `command -v aws` and degrades
  gracefully (logs `[env] aws CLI missing — /bclaw/_* not materialized
  (non-fatal)`), so the gateway never crashes — but the feature silently no-ops
  on every claw until `aws` is added to the image. That image change is the
  **blocking prerequisite** for this RFC; it is not an open question. Fallbacks
  if shipping `aws` is undesirable: (a) install it at boot (needs root +
  network; the `Command` runs as uid 1000 via the entrypoint, so `dnf`/`apt`
  are out — would need a root-stage image fixup), (b) use a tool already in the
  image (e.g. `boto3` if hermes bundles it), or (c) fall back to the
  deployer-side design (with its plaintext-in-context caveat). None chosen;
  in-image `aws` is preferred.
- **Boot now depends on SSM reachability (non-fatal).** The container process
  gains a boot-time AWS dependency (the `aws ssm describe/get` calls). If SSM is
  unreachable, materialize fails — but the non-fatal wrapper logs and proceeds,
  so the Slack bot still starts with whatever `.env` exists. This is the same
  posture as the `gh auth` block (GitHub outage → non-fatal).
- **List action is on `Resource: "*"`.** `DescribeParameters` (or
  `GetParametersByPath`) is a list-style action that can't be scoped to a param
  ARN; it lists metadata account-wide. This is precedented (the deployer policy
  already grants `DescribeParameters` on `*`), and values are still pinned to
  `parameter/bclaw/*`. The list result is filtered to `/bclaw` + `_`-leaf.
- **Task-role privilege expansion (documented).** The task role gains runtime
  SSM read on `/bclaw/*` + KMS decrypt. As noted in Background fact 4, this is
  not a new exposure of values the container couldn't already see (every
  `secrets[]` value is already in its env); it adds the *capability to re-fetch*
  at runtime, which is exactly the mechanism. Scoped to `/bclaw/*` + the claw's
  own CMK.
- **Secret at rest on the EBS volume.** The materialized `.env` holds plaintext
  on `/data/hermes/.env` (EBS, encrypted at rest, mode `0600`, uid 1000). This
  is identical to how a local hermes install stores user-managed secrets, and
  the values are already present in the running container's environment — so it
  adds a persisted-to-disk copy, not a new exposure class. Teardown deletes the
  volume; no separate `.env` cleanup is needed (unlike the deployer-side design,
  which would have left a static copy needing a teardown step).
- **`hermes config` / `.env` write collision.** See Technical Details → write
  semantics. Overwrite-by-default, merge-if-confirmed-needed.
- **Golden test.** The convention adds no new `bclaw`/`us-east-1` tokens beyond
  what `template.yaml` already carries (the `/bclaw` path is already hardcoded),
  so existing residual assertions are unaffected. The task-role policy +
  Command edits flow through the byte-for-byte golden check as usual.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| **On-boot, in-container via task role (this RFC)** | **Chosen** — plaintext never touches the deployer host or the agent context (the agent only ever sees exit codes); auto-rotates on every task start (SSM edit + restart); no `setup-bclaw` refresh phase. Cost: a scoped task-role SSM/KMS grant, a boot-time SSM dependency (non-fatal), and a **blocking dependency on the `aws` CLI being added to the upstream harness image** (it is not shipped today — see Dependencies). |
| **Deployer-side materialize at setup** (earlier draft) | Rejected — routes plaintext through the deployer host **and the agent context**: `get-parameters --with-decryption --query '...Value]'` prints values the agent captures; rendering "locally" holds them; and the `manage-bclaw` transport's `CHUNK=$(cat "$f")` + `--command` embedding would flow the base64 of a secret `.env` through the agent's tool calls. Encapsulating decrypt+render+ship in a self-contained script with suppressed stdout mitigates but does not structurally eliminate context exposure. |
| **Operator-triggered in-container fetch (via a `manage-bclaw` "refresh env" mode over ECS Exec)** | Rejected vs. on-boot — keeps plaintext in-container (same hygiene) but loses auto-rotation (requires an explicit refresh step per edit) and adds a new skill mode. On-boot subsumes it: a restart is already the rotation primitive. |
| **Status quo (template `secrets[]` entry per secret)** | Rejected as the *default* for operator one-offs — a template edit + `cloudformation deploy` per secret is heavyweight and tempts claw-specific secrets into the shared, shipped `template.yaml`. (The template path remains correct for product-owned secrets.) |
| **A second SSM namespace (e.g. `/bclaw-env/*`)** | Rejected — splits the IAM/KMS perimeter into two prefixes for no benefit; the `_`-leaf convention keeps one namespace and one resource pattern (`parameter/bclaw/*`). |

## Migration Notes

- **Integration cycle required.** This is a `template/` hand-edit (task-role
  policy + `Command` + setup-bclaw prose), so it must be validated live in
  `/alt/integration`. The cycle's critical-path checks, in order:
  1. **`aws` CLI must be in the harness image first** — the blocking dependency
     (see Dependencies). Once the image is updated, confirm `command -v aws`
     resolves inside a running container; do not start the rest of the cycle
     until it does (the feature no-ops without it).
  2. Add the task-role policy; create `/bclaw/_TEST=hello`; force a new task;
     shell in and confirm `~/.hermes/.env` contains `TEST=hello` and that the
     gateway sees it (e.g. the var is live in the process env).
  3. Confirm the non-fatal path: delete `/bclaw/_TEST`, restart, confirm
     `.env` no longer has `TEST` and the gateway still starts clean.
  4. Confirm rotation: `put-parameter --overwrite` a new value, restart,
     confirm the new value is live.
  5. Exercise teardown — confirm `/bclaw/_TEST` is swept by the existing
     `/bclaw/*` delete and the EBS volume deletion leaves no `.env` residue.
- **Teardown alignment.** `_`-prefixed params are ordinary `/bclaw/*` params,
  so the existing teardown sweep already covers them. The materialized `.env`
  lives on the EBS volume, which teardown deletes — no new cleanup step is
  needed (a simplification over the deployer-side design).
- **Journal:** record issues in
  `/workspace/references/integrations/2026-07-16_underscore-ssm-secrets-to-hermes-env.md`.
- **Port-back:** after the live check, reconcile
  `diff -rq /workspace/template /alt/integration
  --exclude=.git --exclude=.agents/skills --exclude=node_modules --exclude=dist`
  and confirm the task-role policy + Command + setup-bclaw prose match on both
  sides.
- **Existing deployments:** adopting on an existing claw requires a stack
  update (to add the task-role grant + Command) — unlike the deployer-side
  design, this is *not* purely additive to a running claw, because the task
  role and Command live in `template.yaml`. The deployer policy needs no change
  (it already grants the deployer the SSM/KMS actions for creating the params).

## Implementation Checklist

- [ ] **Add `aws` CLI to `ghcr.io/boldblackai/harness`** (blocking dependency
      — the image does not ship it today; see Dependencies). This is an
      upstream image change, not a template change. Verify `command -v aws`
      resolves inside a running container before anything else below.
- [ ] Add the `materialize-env-secrets` inline policy to `TaskRole` in
      `template/.agents/skills/setup-bclaw/template.yaml`.
- [ ] Extend the container `Command` with the non-fatal materialize block,
      ordered before `exec hermes gateway`.
- [ ] Add the optional `_`-prefix subsection to setup-bclaw Phase 3 + a Notes
      bullet (convention, authoritative-overwrite semantics, non-fatal posture,
      `aws`-CLI dependency).
- [ ] Confirm the `hermes config` / `.env` write interaction in cloud mode;
      switch the boot script to merge semantics if it writes `.env` at runtime.
- [ ] Add a one-line mention in `teardown-bclaw/SKILL.md` that `_`-prefixed
      params are covered by the existing `/bclaw/*` delete sweep (no new step).
- [ ] Update `template/README.md` (and `template/AGENTS.md` if it lists secret
      mechanisms) to mention the `_`-prefix escape hatch.
- [ ] Integration cycle in `/alt/integration`: after `aws` is confirmed in the
      image, create `/bclaw/_TEST`, verify materialize + gateway sees it,
      exercise rotation + teardown.
- [ ] Port back; reconcile `template/` ↔ `/alt/integration`; confirm the golden
      test stays green (`pnpm test`).
