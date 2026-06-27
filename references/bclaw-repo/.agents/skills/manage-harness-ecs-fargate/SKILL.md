---
name: manage-harness-ecs-fargate
description: >
  Manage a running ECS Fargate claw via ECS Exec. Two modes: (1) Update —
  overlay the repo's agent_home/ directory onto the claw's ~/.hermes
  (EFS-backed) to push config, skills, memories, system prompt, or persona
  changes without a full redeploy; (2) Run — execute arbitrary commands on
  the live claw for inspection, debugging, or one-off operations. Companion
  to setup-harness-ecs-fargate / teardown-harness-ecs-fargate.
---

# Manage Harness ECS Fargate

Manage a live ECS Fargate claw through ECS Exec (SSM Session Manager). This
skill handles two related tasks:

1. **Update** (default) — overlay the repo's `agent_home/` onto the claw's
   `~/.hermes` to push curated state (config, skills, memories, prompts,
   personas) without a CloudFormation redeploy or image rebuild.
2. **Run** — execute arbitrary commands on the live claw: inspect files,
   check process state, run diagnostics, or perform one-off operations like
   deleting a file that was removed from `agent_home/`.

Both modes share the same prerequisites and ECS Exec transport. Determine
which mode the user needs from context, or ask. When in doubt, default to
**Update** (the common case).

## Prerequisites

1. **The claw is already set up and RUNNING.** This skill manages a live
   claw; it does not create one (use `setup-harness-ecs-fargate` first).
   Verify the task is `RUNNING` in the first step of either mode.

2. **ECS Exec permissions on the caller.** `aws ecs execute-command` uses SSM
   Session Manager. The deployer principal (the key in `.env`) needs
   `ecs:ExecuteCommand` (on the cluster + task) plus the four `ssmmessages:*`
   channel actions. These are already in the `bclaw-deploy` policy (`ECSExec`
   + `SSMMessages` statements) — no separate addition needed. If the caller
   still gets an `AccessDeniedException` naming `ssmmessages` or
   `ecs:ExecuteCommand`, re-attach the policy in the console (file edits
   don't take effect until re-attached).

3. **SSM Session Manager plugin installed locally.** Required by
   `aws ecs execute-command`. See the
   [install guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
   If you lack root (no `sudo`/`dpkg -i`), extract the binary from the `.deb`
   without installing it:

   ```bash
   # ARM64 (aarch64) — adjust arch if needed
   curl -sL -o /tmp/smp.deb \
     "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_arm64/session-manager-plugin.deb"
   mkdir -p /tmp/smp && dpkg-deb -x /tmp/smp.deb /tmp/smp
   mkdir -p ~/.local/bin
   cp /tmp/smp/usr/local/sessionmanagerplugin/bin/session-manager-plugin ~/.local/bin/
   export PATH="$HOME/.local/bin:$PATH"   # add to shell rc for persistence
   session-manager-plugin --version       # verify: 1.2.xxx.x
   ```

   No mise/asdf plugin exists for this tool — `~/.local/bin` is the pragmatic
   install path.

4. **Shell with mise + direnv + AWS creds** (same as setup/teardown):

```bash
eval "$(/usr/local/bin/mise activate bash)" \
  && eval "$(direnv hook bash)" \
  && cd /workspace \
  && eval "$(direnv export bash)"
```

All `aws` commands in this skill assume this shell state.

## Shared first step: connect to the claw

Both modes start here. Collect the **claw name** (default `bclaw`) and
**region** (default `us-east-1`) via `ask_user_question`. Then verify the
claw is live and ECS Exec works.

```bash
CLAW_NAME=bclaw
AWS_REGION=us-east-1
```

Verify the service exists and a task is `RUNNING`:

```bash
aws ecs describe-services --cluster "$CLAW_NAME" --services "$CLAW_NAME" \
  --region "$AWS_REGION" \
  --query 'services[0].{Status:status, Desired:desiredCount, Running:runningCount}' \
  --output table
```

Expected: `Status = ACTIVE`, `Running >= 1`. If `Running = 0`, the claw is
down — start it (`aws ecs update-service --cluster "$CLAW_NAME" --service
"$CLAW_NAME" --desired-count 1 --region "$AWS_REGION"`) or run the setup
skill first.

Capture the task ARN (reused in every later exec call):

```bash
TASK_ARN=$(aws ecs list-tasks --cluster "$CLAW_NAME" --region "$AWS_REGION" \
  --query 'taskArns[0]' --output text)
echo "$TASK_ARN"
```

**Smoke-test ECS Exec** — confirms the caller has exec perms and the plugin
works (the exec session runs as **root**):

```bash
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive --command "sh -c 'id && echo EXEC_OK'" \
  --region "$AWS_REGION"
```

> **`--command` must wrap compound commands in `sh -c`.** The exec session
> passes `--command` to the container's entrypoint, which does NOT interpret
> shell operators (`&&`, `||`, `;`, `|`). A bare `"id && echo EXEC_OK"` fails
> with `id: '&&': no such user` — each token becomes an argument to `id`.
> Always wrap compound commands: `--command "sh -c '...'"`. Single commands
> (`rm -f /path`, `wc -c < /path`) work fine unwrapped.

You should see `uid=0(root)...` and `EXEC_OK`. If you see an
`AccessDeniedException` naming `ssmmessages` or `ecs:ExecuteCommand`, the
caller lacks exec perms — see Prerequisites §2. If it complains about a
missing "Session Manager plugin", install it (Prerequisites §3).

---

## Mode 1: Update — overlay agent_home/

Overlays the repo's `agent_home/` directory onto the running claw's
`/home/harness/.hermes` — the EFS-backed home directory that persists config,
skills, memories, sessions, and plugins across task restarts.

### What "overlay" means

This is a **merge with overwrite**, not a replace:

- Files in `agent_home/` that are **new** → added to `~/.hermes/`.
- Files in `agent_home/` that **differ** → overwritten in `~/.hermes/`.
- Files in `~/.hermes/` **not in** `agent_home/` → **preserved** (sessions,
  runtime caches, `~/.config/gh` state, anything the claw generated at runtime).

You curate only what you want to control in `agent_home/` and leave the rest to
the claw. `tar` extraction into the destination implements exactly this — it
writes files present in the archive and never deletes anything. If a file was
removed from `agent_home/` and must also be deleted on the claw, use Mode 2
(Run) to `rm` it explicitly — or fold the `rm` into the Phase 3 extract step for
an atomic overlay+delete in one exec round-trip. This is always a manual,
per-run decision.

### Transport: tar + base64 over ECS Exec

There is no shared filesystem between the deployer machine and the Fargate task,
and the deployer has no direct NFS access to the EFS mount target (it lives in
the claw's private subnet, behind a security group that only allows
self-referenced NFS). The transfer therefore goes over **ECS Exec** (SSM Session
Manager, already enabled by the setup template's `EnableExecuteCommand: true`):
locally tar+gzip+base64 the `agent_home/` tree, ship the base64 to the container
in chunks via `aws ecs execute-command`, then decode + extract + fix ownership
in a final call. No S3 bucket, no GitHub dependency, no image rebuild.

### The path mapping

`agent_home/` is the **root** that maps 1:1 onto `~/.hermes/`:

| Repo path | Lands at |
|---|---|
| `agent_home/config.yaml` | `/home/harness/.hermes/config.yaml` |
| `agent_home/system-prompt.md` | `/home/harness/.hermes/system-prompt.md` |
| `agent_home/skills/foo/SKILL.md` | `/home/harness/.hermes/skills/foo/SKILL.md` |
| `agent_home/memories/...` | `/home/harness/.hermes/memories/...` |

Create `agent_home/` at the repo root and mirror the structure you want on the
claw. Include only files you intend to control — everything else is left alone.

### Phase 1: Prepare the payload

**Gate: shared first step (connect) passed.**

Confirm `agent_home/` exists and is non-empty:

```bash
test -d /workspace/agent_home \
  && find /workspace/agent_home -type f | head \
  || echo "agent_home/ does not exist or is empty"
```

If `agent_home/` is missing, there is nothing to overlay — stop and tell the
user to create it (see "The path mapping" above).

Create the tarball. Exclude things that should never be pushed (git metadata,
local caches, editor cruft):

```bash
( cd /workspace/agent_home \
  && tar czf /tmp/agent_home.tar.gz \
    --exclude='.git' --exclude='.DS_Store' --exclude='__pycache__' \
    --exclude='*.pyc' --exclude='.cache' \
    --exclude='AGENTHOME.md' \
    . ) \
  && ls -lh /tmp/agent_home.tar.gz
```

`AGENTHOME.md` (repo-level docs about the `agent_home/` directory itself) is
excluded so it doesn't land on the claw.

Base64-encode it (single line, no wrapping) and measure:

```bash
base64 -w0 /tmp/agent_home.tar.gz > /tmp/agent_home.b64
B64_SIZE=$(wc -c < /tmp/agent_home.b64)
echo "base64 payload: ${B64_SIZE} bytes (~$(( B64_SIZE / 1024 )) KiB)"
```

**Size guidance:** payloads under ~300 KiB transfer in a handful of chunks and
take well under a minute. If the payload is much larger, you are probably
including caches or binaries that don't belong in `agent_home/` — review the
excludes. (For genuinely large payloads, see the S3-presigned-URL alternative in
Notes.)

### Phase 2: Dry-run — show what would change

**Gate: payload prepared (Phase 1).**

Before overwriting live state, show the user what the overlay contains and any
notable diffs against the claw's current copy.

List the files in the payload:

```bash
tar tzf /tmp/agent_home.tar.gz | sort
```

For the few files that matter most (e.g. `config.yaml`, `system-prompt.md`),
diff against the claw's current copy (one exec round-trip each — do only for the
handful worth checking):

```bash
# Example: diff config.yaml against the live claw
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'cat /home/harness/.hermes/config.yaml 2>/dev/null || echo ABSENT'" \
  --region "$AWS_REGION" 2>/dev/null | sed 's/\r$//' > /tmp/claw_config.current
diff -u /tmp/claw_config.current /workspace/agent_home/config.yaml || true
```

> The `sed 's/\r$//'` strips the carriage returns the exec PTY appends to each
> line so the diff is clean. Apply the same filter when diffing any remote file.

**Gate:** use `ask_user_question` to confirm the user wants to apply the overlay
(show the file list + any notable diffs). This overwrites live files — get
explicit confirmation before Phase 3.

### Phase 3: Transfer and overlay

**Gate: user confirmed the overlay (Phase 2).**

Ship the base64 payload to the container in chunks, verify the staged length
matches locally, then decode + extract + fix ownership. The exec session runs as
**root**, so `chown -R 1000:1000` is required after extraction — without it the
non-root gateway (uid/gid 1000) can't modify or delete the files later (EFS
honors POSIX ownership).

```bash
DEST_B64=/tmp/.ah_update.b64          # staging path on the container
CHUNK_SIZE=30000                      # bytes per exec round-trip (see Notes)

# --- split the base64 into chunk files locally (numeric suffixes) ---
rm -f /tmp/ah_chunk_*
split -b "$CHUNK_SIZE" -d -a 4 /tmp/agent_home.b64 /tmp/ah_chunk_

# --- clear staging on the container ---
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive --command "rm -f $DEST_B64" \
  --region "$AWS_REGION" >/dev/null 2>&1

# --- append each chunk to the staging file ---
TOTAL=$(ls /tmp/ah_chunk_* 2>/dev/null | wc -l)
i=0
for f in /tmp/ah_chunk_*; do
  i=$((i + 1))
  CHUNK=$(cat "$f")
  # base64 chars (A-Za-z0-9+/=) are shell-safe unquoted, so printf %s embeds
  # the chunk verbatim into the staging file. No quoting pitfalls.
  aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
    --container hermes --interactive \
    --command "sh -c 'printf %s ${CHUNK} >> ${DEST_B64}'" \
    --region "$AWS_REGION" >/dev/null 2>&1 \
    && echo "  chunk $i/$TOTAL appended" \
    || { echo "  chunk $i FAILED — re-run this phase"; exit 1; }
done

# --- verify the staged base64 length matches the local source ---
REMOTE_LEN=$(aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "wc -c < $DEST_B64" \
  --region "$AWS_REGION" 2>/dev/null | tr -dc '0-9')
echo "local=${B64_SIZE} remote=${REMOTE_LEN}"
[ "$REMOTE_LEN" = "$B64_SIZE" ] || { echo "LENGTH MISMATCH — aborting before extract"; exit 1; }
```

If the lengths match, **decode + extract (overlay) + fix ownership + clean up**:

```bash
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'set -e; base64 -d $DEST_B64 | tar xzf - -C /home/harness/.hermes; chown -R 1000:1000 /home/harness/.hermes; rm -f $DEST_B64; echo OVERLAY_DONE'" \
  --region "$AWS_REGION"
```

Look for `OVERLAY_DONE`. If the `tar x` step fails with "unexpected EOF" or
"archive is truncated", the base64 was corrupted in transit (a chunk was dropped
or truncated by the SSM command-length limit) — lower `CHUNK_SIZE` (e.g. 10000)
and re-run this phase.

### Phase 4: Verify and decide on a restart

**Gate: Phase 3 printed `OVERLAY_DONE`.**

Spot-check that the files landed with the right ownership (should be
`harness:harness` / `1000:1000`):

```bash
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'stat -c \"%U:%G %n\" /home/harness/.hermes/config.yaml 2>/dev/null; find /home/harness/.hermes/skills -maxdepth 2 -type f 2>/dev/null | head -20'" \
  --region "$AWS_REGION"
```

**Does the gateway need a restart?** Depends on what changed:

- **Skills, memories, personas** → usually **no restart**. Hermes loads these
  dynamically per turn in most configurations.
- **`config.yaml`** → **restart recommended** if you changed model, provider,
  toolsets, MCP servers, or gateway behavior (read at startup).
- **MCP server config, plugins** → **restart required** (loaded at boot).
- **`system-prompt.md`** → restart recommended (compiled at startup).

To restart (forces a new task that re-runs the full boot chain, including the
on-boot `gh auth login`):

```bash
aws ecs update-service --cluster "$CLAW_NAME" --service "$CLAW_NAME" \
  --force-new-deployment --region "$AWS_REGION"
aws ecs wait tasks-running --cluster "$CLAW_NAME" \
  --tasks "$(aws ecs list-tasks --cluster "$CLAW_NAME" --region "$AWS_REGION" \
    --query 'taskArns[0]' --output text)" \
  --region "$AWS_REGION"
```

Use `ask_user_question` to ask whether to restart now, given what changed.

---

## Mode 2: Run commands on the claw

Execute arbitrary commands on the live claw via ECS Exec. Use this for
inspection, debugging, or one-off operations that don't fit the overlay model —
e.g. deleting a file removed from `agent_home/`, checking process state,
inspecting logs, or running diagnostics.

**Gate: shared first step (connect) passed.**

The exec session runs as **root**. To act as the workload user (uid 1000),
prefix commands with `runuser -u harness --`:

```bash
# Read a file as the harness user
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'cat /home/harness/.hermes/config.yaml'" \
  --region "$AWS_REGION"

# List files the claw has generated (runtime state not in agent_home/)
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'runuser -u harness -- ls -la /home/harness/.hermes/'" \
  --region "$AWS_REGION"
```

### Deleting a file removed from agent_home/

The overlay (Mode 1) is merge-only — it never deletes files absent from
`agent_home/`. If a file was intentionally removed from `agent_home/` and
should also be removed from the claw, delete it explicitly:

```bash
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'rm -f /home/harness/.hermes/<file> && echo DELETED'" \
  --region "$AWS_REGION"
```

This is a one-off manual step — do not bake deletions into the overlay flow.

### Inspecting claw state

```bash
# Check running processes
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'ps aux | head -20'" \
  --region "$AWS_REGION"

# Check recent gateway logs (if writing to files)
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'ls -lt /home/harness/.hermes/logs/ 2>/dev/null | head; tail -50 /home/harness/.hermes/logs/*.log 2>/dev/null'" \
  --region "$AWS_REGION"

# Check disk usage on EFS mount
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'df -h /home/harness'" \
  --region "$AWS_REGION"

# Inspect sessions count
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "sh -c 'ls /home/harness/.hermes/sessions/ 2>/dev/null | wc -l'" \
  --region "$AWS_REGION"
```

### Interactive shell

For exploratory work, drop into an interactive bash session:

```bash
aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive \
  --command "/bin/bash" \
  --region "$AWS_REGION"
```

Then browse as the workload user: `runuser -u harness -- ls ~/.hermes/`

### Handling exec output

Every `execute-command` result includes boilerplate you must strip when parsing
output programmatically (see Notes for details):

- `The Session Manager plugin was installed successfully...`
- `Starting session with SessionId: ...`
- `Cannot perform start session: EOF`
- Every line ends with `\r\n` from the PTY.

For numeric extraction: pipe through `tr -dc '0-9'`. For file content: pipe
through `sed 's/\r$//'`.

---

## Notes

- **Exec runs as root.** `aws ecs execute-command` opens a **root** shell (see
  the setup skill's Phase 5 note). Files written or modified by exec are owned
  by root unless you `chown -R 1000:1000` afterward. Without it the non-root
  gateway can't later modify or delete those files (EFS honors POSIX ownership).
  Use `runuser -u harness --` to run commands as the workload user (uid 1000)
  when file ownership matters.

- **Exec PTY output noise.** Every `execute-command` result includes boilerplate
  lines you must strip when parsing output programmatically:
  - `The Session Manager plugin was installed successfully. Use the AWS CLI to start a session.`
  - `Starting session with SessionId: ...`
  - `Cannot perform start session: EOF`
  - Every line ends with `\r\n` (carriage return) from the PTY.

  For numeric parsing (e.g. `wc -c`), pipe through `tr -dc '0-9'` to extract
  just the digits. For file content, pipe through `sed 's/\r$//'`. When using
  `execute_code` to drive exec calls, filter with regex rather than string
  matching — the boilerplate lines vary by plugin version.

- **Overlay preserves runtime state.** Because `tar x` only writes files present
  in the archive, the claw's `sessions/`, runtime caches, `~/.config/gh`
  credentials, and anything else absent from `agent_home/` survive untouched.
  This is the key difference from a fresh deploy — you don't lose live sessions
  or stored credentials.

- **Chunk size tuning.** `CHUNK_SIZE=30000` (30 KiB) is a safe default that
  stays well under SSM's command-length limits. If you hit "command too long" or
  a truncated/corrupted chunk, lower it (e.g. 10000). If round-trips feel slow
  and your payload is large, you may raise it toward 60000 — test one chunk
  first and confirm the staged length still matches before extracting.

- **`agent_home/` is the source of truth for curated state.** Anything you put
  there is what the claw gets on every overlay. Keep it lean: config, prompts,
  skills, memories, personas. Do **not** put `sessions/`, `.cache/`, model
  weights, or other runtime-generated/large data in it — the excludes in the
  update flow guard against `.cache`, but any other large file you add gets
  tarred and shipped over exec.

- **`config.yaml` caveat (cloud mode).** In cloud mode
  (`HARNESS_CLOUD_MODE=1`, set by the task definition), the boot entrypoint
  reconciles `config.yaml` from environment variables on every boot. If you
  overlay a hand-edited `config.yaml`, a subsequent task restart may re-seed
  parts of it from env. Overlay `config.yaml` only for keys that are **not**
  env-driven (e.g. skills, toolsets, MCP servers, model overrides). For
  env-driven keys (API keys, Slack config), update the SSM parameters instead
  (see the setup skill's Phase 3 / Phase 5a token-rotation recipe).

- **Idempotent.** Running the update mode twice with the same `agent_home/` is a
  no-op (identical files overwrite themselves). Safe to re-run after fixing a
  typo.

- **Large-payload alternative: S3 presigned URL.** If `agent_home/` ever grows
  past a few hundred KiB, skip the base64 chunking: upload the tarball to S3
  (`aws s3 cp /tmp/agent_home.tar.gz s3://<bucket>/agent_home.tar.gz`), generate
  a presigned URL (`aws s3 presign s3://<bucket>/agent_home.tar.gz`), then on
  the container run `curl -sL "<url>" | tar xzf - -C /home/harness/.hermes`
  followed by `chown -R 1000:1000 /home/harness/.hermes`, then delete the S3
  object. This needs an S3 bucket but has no size limit and uses one exec
  round-trip. The container needs only `curl` (present in the base image) — the
  presigned URL carries no credentials, so no task-role S3 permissions are
  needed.

- **Companion skills.** `setup-harness-ecs-fargate` (create the claw),
  `teardown-harness-ecs-fargate` (destroy it). This skill sits between them: it
  mutates or inspects the live claw without touching the CloudFormation stack
  or the task definition.
