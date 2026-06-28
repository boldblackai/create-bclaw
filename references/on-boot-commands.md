# Running On-Boot Commands Without a Derived Image

How to run a command on every container start (auth, file seeding, migration)
in the ECS Fargate claw WITHOUT building a custom Docker image. The signed
upstream `ghcr.io/boldblackai/harness` image is deployed as-is; on-boot logic
is injected via the task definition's `Command` override only (the image's
baked-in ENTRYPOINT runs unchanged — see the boot chain below).

## The boot chain

The image's ENTRYPOINT is `["/tini", "--", "/entrypoint.sh"]` (verified via
`/proc/1` in a running container). ECS `Command` overrides only CMD, NOT
ENTRYPOINT — so this chain runs on every boot regardless of what `Command` is
set to:

```
/tini (PID 1 — signal forwarding + zombie reaping)        ← from image ENTRYPOINT
  └─ /entrypoint.sh                                       ← from image ENTRYPOINT
       ├─ sources /etc/harness/setup-env.sh
       │    ├─ routes GIT_CONFIG_GLOBAL → persisted ~/.config/gitconfig
       │    └─ seeds the `gh auth git-credential` helper into that gitconfig
       ├─ stamps ~/.hermes/.install_method = docker
       └─ seeds/reconciles ~/.hermes/config.yaml (cloud mode: self-seeds from env)
  └─ exec "$@"                                            ← "$@" = the task Command
       └─ <your pre-work>; exec hermes gateway             ← runs as uid 1000
```

The task definition sets ONLY `Command` (no `EntryPoint` — it's baked into the
image):

```yaml
# EntryPoint: NOT set here — the image's [/tini, --, /entrypoint.sh] runs
Command:
  - sh
  - -c
  - '<pre-work>; exec hermes gateway'
```

## Why /entrypoint.sh must run first (pitfall)

`/entrypoint.sh` sources `/etc/harness/setup-env.sh`, which seeds
`GIT_CONFIG_GLOBAL` (`~/.config/gitconfig`) with the `gh auth git-credential`
helper. Any on-boot command that relies on `gh` or HTTPS-git auth depends on
this having run. Because `Command` overrides only CMD (not ENTRYPOINT), the
image's ENTRYPOINT chain — including `/entrypoint.sh` — always runs before your
`Command`. Do NOT set an explicit `EntryPoint` that bypasses `/entrypoint.sh`
(e.g. `EntryPoint: ["/tini", "--", "sh", "-c", ...]` directly); that would
skip the gitconfig seeding and break later git auth.

## tini vs LinuxParameters.InitProcessEnabled

The image ships `/tini` and uses it as the ENTRYPOINT (PID 1) for signal
forwarding and zombie reaping. Do NOT set `LinuxParameters:
{ InitProcessEnabled: true }` — ECS's init process and tini both act as
PID-1-style reapers; stacking them is redundant, and tini is the better signal
forwarder for `hermes gateway`. The template sets neither `EntryPoint` nor
`InitProcessEnabled` — it relies on the image's baked-in tini ENTRYPOINT and
overrides only `Command`. (Pre-existing versions of the template used
`InitProcessEnabled` alone; it was removed when the boot-chain was verified via
`/proc/1` — see `references/template-pitfalls.md` §9.)

## Non-fatal pre-work pattern

For on-boot commands that should NOT block the gateway (e.g. auth that may
fail transiently), use `||` to swallow the exit code, log the failure, then
fall through to `exec`:

```sh
printf "%s" "$SECRET" | some-auth-cmd 2>&1 || echo "[auth] failed (non-fatal)"
exec hermes gateway
```

The gateway starts regardless; the failure is visible in CloudWatch logs. For
commands that MUST succeed before the gateway runs, drop the `||` so a failure
exits non-zero and the task stops (crash-loops until fixed).

## Piping secrets: printf, not echo

When piping an SSM-injected secret to a command's stdin, use
`printf "%s" "$VAR"` rather than `echo "$VAR"`:
- A token beginning with `-` (e.g. `ghp_-...`) can be parsed as an echo flag.
- `printf "%s"` emits no trailing newline; most CLIs trim whitespace, but
  being exact avoids edge cases.

## Why the Command-wrapper approach (over alternatives)

The claw deploys the upstream image as-is (no derived image — see SKILL.md
Notes), so on-boot logic can't live in a custom entrypoint. Alternatives
considered and rejected:
- **Derived image with custom entrypoint** — violates the no-derived-image
  rule; loses signed-image provenance; adds a build step on every upgrade.
- **ECS init/sidecar container writing the gh session to shared EFS** — works,
  but adds a second container + volume wiring for a one-line auth command.
  Overkill; EFS is already shared, but the wrapper is simpler and equally
  persistent.
- **One-time manual `exec` after deploy** (the old Phase 5a) — not
  rotation-safe; breaks on task replacement (new task starts unauthenticated
  until a human re-runs the login). The wrapper re-runs on every boot, so a
  rotated SSM param + `--force-new-deployment` is all that's needed.

The wrapper wins: automatic, rotation-safe, no image build, single container.

## Worked example: on-boot GitHub auth (GH_TOKEN_VAL)

When GitHub auth is enabled (`EnableGitHubKey=true`), the claw authenticates
`gh` from an SSM param on every boot. The `if [ -n ... ]` guard makes it a
silent no-op when disabled (no `GH_TOKEN_VAL` injected, no `[gh-auth]` log):

```yaml
# EntryPoint: NOT set — image's [/tini, --, /entrypoint.sh] runs from ENTRYPOINT
Command:
  - sh
  - -c
  - 'if [ -n "$GH_TOKEN_VAL" ]; then printf "%s" "$GH_TOKEN_VAL" | gh auth login --with-token 2>&1 || echo "[gh-auth] login failed (non-fatal)"; fi; exec hermes gateway'
```

### Pitfall: the secret MUST be named GH_TOKEN_VAL, not GH_TOKEN

`gh` treats `GH_TOKEN` as a reserved environment variable. When `GH_TOKEN` is
present in the environment (which it would be if the ECS secret were named
`GH_TOKEN` — ECS injects secrets as env vars), `gh auth login --with-token`
**refuses to store** the token into `~/.config/gh/hosts.yml`, printing:

```
The value of the GH_TOKEN environment variable is being used for authentication.
To have GitHub CLI store credentials instead, first clear the value from the environment.
```

and exiting 1. The non-fatal `||` handler then logs `[gh-auth] login failed
(non-fatal)` every boot, and no credential is stored.

**Fix:** name the SSM param `/bclaw/GH_TOKEN_VAL` (and the secret `Name:
GH_TOKEN_VAL` in the task definition). Since `GH_TOKEN_VAL` is not a reserved
gh env var, gh reads the token from stdin and stores it normally. This is why
the template uses `GH_TOKEN_VAL` everywhere.

### Why storing matters (can't rely on the env var)

Storing the token to `hosts.yml` is **necessary**, not optional: the harness
terminal/execute_code sandbox scrubs token-like env vars from its environment,
so `gh`/git calls the agent makes via those tools find no `GH_TOKEN_VAL` in
their env — they rely on the stored credential in `~/.config/gh/hosts.yml` (on
EFS, persists across restarts). Without the stored credential, agent-initiated
`gh`/git operations would fail authentication.

`GH_TOKEN_VAL` is a **conditional** entry in `secrets[]` — present only when
`EnableGitHubKey=true` (opt-in, the same pattern as the inference-provider
keys); when disabled it resolves to `AWS::NoValue`, the task starts fine with
no SSM param present, and the `Command`'s guard skips the login. The gh
session persists in
`~/.config/gh` (EFS), and setup-env.sh has already
wired the `gh auth git-credential` helper into gitconfig, so HTTPS git
operations use the same token. To rotate: `ssm put-parameter --overwrite` on
`/bclaw/GH_TOKEN_VAL` then `update-service --force-new-deployment` (the boot
command re-runs on every task start).

See SKILL.md → Notes → "On-boot GitHub auth" for the full feature notes.
