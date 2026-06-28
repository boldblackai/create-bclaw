---
name: setup-harness-ecs-fargate
description: >
  Bootstraps a Hermes Agent claw on AWS ECS Fargate from scratch to a running
  gateway. Follows a gated sequence: probe ARM64 AZs → deploy CloudFormation
  (VPC, EFS, ECS service at DesiredCount 0) → write SSM secrets → scale to 1
  → verify. Use when setting up a new claw on AWS, migrating from fly.io, or
  re-deploying after teardown. Companion to teardown-harness-ecs-fargate.
---

# Setup Harness ECS Fargate

Bootstraps a Hermes Agent claw on AWS ECS Fargate. The claw is a Slack
socket-mode bot (see `README.md` + `slack-manifest.json`) — it is outbound-only,
so there is no load balancer and no inbound ports (the security group only
allows self-referenced NFS for EFS).

The CloudFormation stack (`template.yaml` alongside this skill) owns the VPC,
EFS file system + 4 access points (one per persisted path, mirroring the
harness CLI bind-mounts), IAM roles, log group, task definition, and an ECS
service that starts at DesiredCount 0. Secrets are **not** owned by the stack —
they live in SSM Parameter Store as namespaced SecureStrings that the user
writes in Phase 3. This is the piranesi pattern: it keeps secrets out of
template diffs and lets them survive stack deletes.

## Prerequisites

This skill assumes AWS credentials are already configured. See `README.md` →
**Setup** for the one-time IAM onboarding (create the deployer user, attach the
`bclaw-deploy-policy.json` policy, add the access key to `.env`). That must be
completed before running this skill. Permissions are not pre-checked — if the
deployer principal is missing an action, CloudFormation will surface the exact
`is not authorized to perform` error at deploy time (Phase 2).

Before starting, ensure the shell has `mise` and `direnv` active and AWS
credentials loaded. `mise` manages `aws-cli` (see `mise.toml`); credentials
live in `.env` (gitignored) and are exported by `direnv` (`.envrc`):

```bash
eval "$(/usr/local/bin/mise activate bash)" \
  && eval "$(direnv hook bash)" \
  && cd /workspace \
  && eval "$(direnv export bash)"
```

All `aws` commands in this skill assume this shell state. Verify the caller:

```bash
aws sts get-caller-identity --query 'Account' --output text
```

If that fails, stop — the user hasn't completed the README Setup steps yet.

## Setup Sequence

Follow these phases **in order**. Each phase has a gate that must be satisfied
before proceeding. Use `ask_user_question` (the `clarify` tool) to confirm
completion and collect input where called for.

---

### Phase 1: Collect configuration and probe ARM64 AZs

**Gate: user confirms the AWS region and inference provider.**

The claw name is the name the repo was generated under — it is fixed, not
collected. `$CLAW_NAME` is used as a shell variable in the commands below.

Use `ask_user_question` to collect:

1. **AWS region** (default `us-east-1`). Read the current region with
   `aws configure get region` and offer it as the default.

2. **Inference provider** — which LLM provider the gateway should use. Use
   `ask_user_question` with these three choices:
   - **OpenRouter** (recommended) — multi-model router, broadest model access
   - **Anthropic** — direct Claude API access
   - **Z.AI (GLM)** — Zhipu/z.ai GLM models

   The provider choice determines (a) which provider API-key SSM parameter the
   user creates in Phase 3, and (b) which `Enable*Key=true` override is passed
   to the deploy in Phase 2. Exactly one provider key is enabled — the gateway
   needs at least one to run. (If the user wants more than one — e.g. OpenRouter
   plus Anthropic — they can say so via "Other" and you enable each matching
   `Enable*Key` in Phase 2; otherwise default to a single provider.)

   Provider → stack parameter / SSM key mapping:

   | Provider | `Enable*Key` parameter | SSM parameter |
   |---|---|---|
   | openrouter | `EnableOpenRouterKey` | `/bclaw/OPENROUTER_API_KEY` |
   | anthropic | `EnableAnthropicKey` | `/bclaw/ANTHROPIC_API_KEY` |
   | zai | `EnableZaiKey` | `/bclaw/ZAI_API_KEY` |

3. **GitHub authentication** — whether the agent should make authenticated
   `gh`/HTTPS-git calls. This is OPTIONAL: the claw is a Slack bot and runs
   fine without it. Use `ask_user_question` with these two choices:
   - **Yes** — the claw authenticates `gh` automatically on every boot from
     `/bclaw/GH_TOKEN_VAL` (the container `Command` runs
     `gh auth login --with-token`). Requires creating that SSM parameter in
     Phase 3 and passing `EnableGitHubKey=true` in Phase 2.
   - **No** (default) — no GitHub credential is injected; `gh`/HTTPS-git
     operations will be unauthenticated. The on-boot login is skipped
     entirely (the `Command` guards on `$GH_TOKEN_VAL` being non-empty).

Store them as shell variables used in every later command:

```bash
CLAW_NAME=bclaw                              # the claw name (fixed at generation)
AWS_REGION=<user-provided>
INFER_PROVIDER=<openrouter|anthropic|zai>   # from step 2
ENABLE_GH=<true|false>                      # from step 3 (default false)
```

#### 1a. Probe ARM64-capable availability zones

ARM64 Fargate is ~20% cheaper and the harness image is published multi-arch,
but ARM64 Fargate is **not** available in every AZ of every account. There is
no direct "Fargate ARM64 per-AZ" API, but Fargate ARM64 tasks run on Graviton
hardware, so AZs offering Graviton instance families are a strong proxy. Probe
with `describe-instance-type-offerings`:

```bash
aws ec2 describe-instance-type-offerings \
  --location-type availability-zone \
  --filters Name=instance-type,Values=t4g.* \
  --region "$AWS_REGION" \
  --query 'InstanceTypeOfferings[].Location' --output text | tr '\t' '\n' | sort -u
```

This lists every AZ in the region that offers `t4g.*` (Graviton3). Take the
first two as `AZ1`/`AZ2` and pass them to the stack deploy in Phase 2 as
`--parameter-overrides AZ1=... AZ2=...`.

**Edge cases:**
- If the probe returns **fewer than 2 AZs**, ARM64 capacity is scarce in this
  account/region. Use `ask_user_question` to offer the user a choice:
  (a) proceed with ARM64 using whatever AZs are available plus the default
      `GetAZs` fallback (Fargate will place if it can), or
  (b) switch to `X86_64` for `CpuArchitecture` (works in any AZ, ~20% more
      expensive).
- If the probe **errors** (e.g. permissions), fall back to the template
  defaults (literal string `us-east-1a`/`us-east-1b` — the template can no
  longer use `!GetAZs` in parameter defaults, see
  `references/template-pitfalls.md` §3) and let Fargate's scheduler handle
  placement. Warn the user.

Report the chosen AZs to the user before proceeding.

---

### Phase 2: Deploy the CloudFormation stack (DesiredCount 0)

**Gate: Phase 1 collected the AWS region, inference provider, and AZ1/AZ2; AND
2-pre found no half-started stack** (`describe-stacks` returns `does not exist`
or a healthy `CREATE_COMPLETE`/`UPDATE_COMPLETE`).

#### 2-pre: Detect a half-started or existing stack

Before deploying, check whether a stack named `$CLAW_NAME` already exists. This
is the step that prevents the #1 source of stray stacks: a *previous* run whose
deploy failed and rolled back (stack now in `ROLLBACK_COMPLETE`) or whose
teardown didn't finish (`DELETE_FAILED`). `cloudformation deploy` refuses to run
into a stack in those states — it errors out, and the temptation is then to
deploy under a *different* name, leaving the dead `bclaw` stack orphaned (still
billing its retained EFS, still squatting on the `/bclaw/*` secret namespace).
Detect it here and fix it instead.

```bash
aws cloudformation describe-stacks \
  --stack-name "$CLAW_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>&1
```

This prints the existing stack's status, or an error containing `does not exist`
if there is none. Act on the result:

| Result | State | What to do |
|---|---|---|
| `does not exist` error | Fresh — no prior attempt | Proceed to the deploy below (this is a `CREATE`). |
| `CREATE_COMPLETE` / `UPDATE_COMPLETE` | Already fully deployed | This run is an in-place `UPDATE`, not a fresh deploy. Usually fine (e.g. pushing a `template.yaml` change). But if the user wanted a clean rebuild, run the `teardown-harness-ecs-fargate` skill first. Tell the user it's an update before deploying. |
| `ROLLBACK_COMPLETE` / `CREATE_FAILED` / `ROLLBACK_FAILED` | Half-started: a deploy failed and rolled back | **STOP.** The stack exists but is unusable — `deploy` will refuse to touch it. Tear it down (below), then re-run setup. |
| `UPDATE_ROLLBACK_COMPLETE` / `UPDATE_FAILED` / `UPDATE_ROLLBACK_FAILED` | Half-started: an update on a good stack failed | **STOP.** Cleanest fix is `delete-stack` + redeploy; alternatively `continue-update-rollback` recovers the prior good state. |
| `DELETE_IN_PROGRESS` | A teardown is mid-flight | **STOP.** Wait for it to finish (`stack-delete-complete` waiter), then re-check this step. |
| `DELETE_FAILED` | A teardown stalled (usually stuck EFS mount targets) | **STOP.** See the force-delete fix below, then re-check. |
| `CREATE_IN_PROGRESS` / `UPDATE_IN_PROGRESS` / `*_ROLLBACK_IN_PROGRESS` | A deploy/update is in flight | **STOP.** Wait for a terminal state, then re-check. |
| `REVIEW_IN_PROGRESS` | A stack with a pending change set (rare for `deploy`) | **STOP.** `delete-stack` then redeploy. |

**If the gate stopped on a half-started stack, never abandon it under the
`bclaw` name.** Run the `teardown-harness-ecs-fargate` skill (it scales to 0
first, deletes the stack, and handles the retained-EFS + force-delete gotchas),
or for a quick rollback cleanup:

```bash
aws cloudformation delete-stack --stack-name "$CLAW_NAME" --region "$AWS_REGION"
aws cloudformation wait stack-delete-complete --stack-name "$CLAW_NAME" --region "$AWS_REGION"
```

Two caveats specific to this stack when cleaning up a stale `bclaw`:

- **`DELETE_FAILED` on EFS mount targets is common.** CloudFormation's
  resource handler uses the caller's credentials and can fail to clear EFS
  mount targets even though direct CLI calls (`describe-mount-targets`,
  `delete-file-system`) succeed — the deployer's EFS permissions are
  tag-conditioned (`aws:ResourceTag/Name: bclaw*`), and
  `simulate-principal-policy` returns false `implicitDeny` for them without
  `--context-entries` (see the teardown skill's Phase 0 caveat). Don't trust
  the bare simulate. Re-run `delete-stack --deletion-mode
  FORCE_DELETE_STACK` to skip stuck resources and continue; orphaned EFS
  can then be deleted directly (see the EFS sweep below).

- **Retained EFS survives `delete-stack`** — `EFSFileSystem` has
  `DeletionPolicy: Retain`, so deleting a stale stack leaves its file system
  behind, billed and tagged `${CLAW_NAME}-data`. And if the stack was updated
  several times there may be *several* retained EFS. Before re-deploying, sweep
  for orphans so the fresh deploy doesn't pile a new EFS on top:
  ```bash
  aws efs describe-file-systems --region "$AWS_REGION" \
    --query 'FileSystems[?Tags[?Key==`Name` && Value==`${CLAW_NAME}-data`]].FileSystemId' \
    --output table
  ```
  Keep one if the user wants to preserve sessions/memories; delete the rest
  (see teardown Phase 3) before re-running this skill.

Only proceed to the deploy once this step reports `does not exist` (fresh
`CREATE`) or a healthy `CREATE_COMPLETE`/`UPDATE_COMPLETE` (in-place `UPDATE`).

#### 2-deploy: Create / update the stack

Deploy the stack. It comes up with `DesiredCount: 0` — the task does NOT start
yet, because the SSM secrets don't exist. This avoids the gateway crash-looping
on missing env vars.

Pass `--parameter-overrides` including the `Enable*Key=true` for the provider
chosen in Phase 1 step 2 (`EnableOpenRouterKey` / `EnableAnthropicKey` /
`EnableZaiKey`). Leave the other two at their template default `false` (omit
them) so their secrets resolve to `AWS::NoValue` and the task doesn't try to
fetch SSM parameters that don't exist. If the user opted into GitHub auth in
Phase 1 step 3 (`ENABLE_GH=true`), also pass `EnableGitHubKey=true` — otherwise
omit it (default `false`, no `GH_TOKEN_VAL` injected, on-boot login skipped):

```bash
aws cloudformation deploy \
  --template-file .agents/skills/setup-harness-ecs-fargate/template.yaml \
  --stack-name "$CLAW_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ClawName="$CLAW_NAME" \
    AZ1=<az1-from-phase-1> \
    AZ2=<az2-from-phase-1> \
    <EnableProviderKey>=true \
    EnableGitHubKey="$ENABLE_GH" \
  --no-disable-rollback
```

where `<EnableProviderKey>` is resolved from `$INFER_PROVIDER` per the Phase 1
mapping (e.g. `EnableOpenRouterKey` for openrouter). If the user selected more
than one provider in Phase 1, add each matching `Enable*Key=true` on its own
line. `EnableGitHubKey="$ENABLE_GH"` is safe to always pass — it's `"true"` or
`"false"` straight from Phase 1 step 3.

> **On stack updates you MUST re-pass the provider key override.**
> `cloudformation deploy` uses the template's parameter `Default` (`false`) for
> any parameter omitted from `--parameter-overrides` — it does not remember the
> prior stack's values. Forgetting to re-pass `EnableOpenRouterKey=true` on a
> later update would silently drop the provider key from the task definition and
> the gateway would come up with no model. The same applies to
> `EnableGitHubKey`: omitting it on an update reverts GitHub auth to off, and
> the next task quietly starts unauthenticated. Capture current params with
> `describe-stacks` and re-pass them, then verify the live task def matches
> intent — see `references/template-pitfalls.md`.

Wait for `CREATE_COMPLETE` (the `deploy` command blocks until it finishes).

**Verify the stack and capture outputs:**

```bash
aws cloudformation describe-stacks \
  --stack-name "$CLAW_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs' --output table
```

Confirm `ClusterName`, `ServiceName`, `EFSFileSystemId`, `KmsKeyArn`,
`KmsKeyAlias` (should be `alias/${CLAW_NAME}-ssm`), and
`SsmParameterPrefix` (should be `/bclaw`) are all present.

---

### Phase 3: Write the SSM secrets

**Gate: stack is `CREATE_COMPLETE`.**

The claw needs SSM SecureString parameters under the `/bclaw/` namespace —
**4 that are always required** (Slack), plus an **optional GitHub key** (only
if `ENABLE_GH=true` from Phase 1 step 3), plus **1 inference-provider key**
chosen in Phase 1 step 2. The namespace is hardcoded in the template
(not constructed from `ClawName`), which means the deployer's IAM policy can be
scoped to `arn:aws:ssm:*:*:parameter/bclaw/*` instead of `*`. They are **not** created by CloudFormation — the user
writes them here so they survive stack updates and deletes. The 4 Slack
secrets are unconditional in the task definition's `secrets[]` (the task will
not start if any is missing); the GitHub and provider keys are injected only
because their matching `Enable*Key=true` was passed in Phase 2.

Use `ask_user_question` to give the user the tables below and tell them to enter
each parameter in the **AWS Management Console** (Systems Manager → Application
Management → Parameter Store → **Create parameter**), then wait for
confirmation. The console is the primary path: secret values stay out of the
user's shell history and terminal scrollback (the console masks SecureString
inputs).

**Always required (4):**

| SSM key | What it is | Where to find it |
|---|---|---|
| `/bclaw/SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-`) | Slack app → OAuth & Permissions → Bot User OAuth Token |
| `/bclaw/SLACK_APP_TOKEN` | Slack app-level token (`xapp-`, enables socket mode) | Slack app → Basic Information → App-Level Tokens |
| `/bclaw/SLACK_ALLOWED_USERS` | Comma-separated Slack user IDs allowed to use the bot | Slack profile → "Copy member ID" |
| `/bclaw/SLACK_HOME_CHANNEL` | Slack channel ID the bot treats as home | Right-click channel → "Copy link", take the trailing ID |

**GitHub key (optional, from Phase 1 step 3):** create this only if
`ENABLE_GH=true` — it authenticates `gh`/HTTPS-git on every boot. Skip this
entire subsection if the user opted out.

| SSM key | What it is | Where to find it |
|---|---|---|
| `/bclaw/GH_TOKEN_VAL` | GitHub PAT — used for on-boot `gh auth login` (see Phase 5a). Named `*_VAL`, not `GH_TOKEN`, to dodge `gh`'s reserved env var (see `references/on-boot-commands.md`) | https://github.com/settings/tokens (classic PAT or fine-grained; needs the scopes the claw's `gh`/git usage requires) |

**Inference-provider key (1, from Phase 1 `$INFER_PROVIDER`):** create the one
matching the chosen provider — this is the key the gateway uses as its model
backend.

| `$INFER_PROVIDER` | SSM key | Where to find it |
|---|---|---|
| openrouter | `/bclaw/OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| anthropic | `/bclaw/ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| zai | `/bclaw/ZAI_API_KEY` | https://z.ai/manage-apikey/apikey-list (Zhipu AI / open.bigmodel.cn for mainland China) |

For each parameter the user creates in the console, the settings are:

- **Tier:** `Standard`
- **Type:** `SecureString`
- **KMS Key ID:** `alias/${CLAW_NAME}-ssm` — the claw's own CMK, created by the
  stack in Phase 2. **NOT** the default `alias/aws/ssm`. Type the alias name
  (e.g. `alias/bclaw-ssm`) into the console's KMS key picker; it resolves to
  the key the template just created.
- **Value:** the secret itself (masked input).

> **CLI fallback.** If the console is unavailable or the user prefers
> scripting, the same parameters can be written from a shell. Prefix the
> command with a leading space so the value stays out of shell history:
>
> ```bash
>  aws ssm put-parameter --name "/bclaw/SLACK_BOT_TOKEN" \
>    --type SecureString --key-id "alias/${CLAW_NAME}-ssm" \
>    --value "<token>" --region "$AWS_REGION"
> # repeat for the other 3 Slack secrets + the provider key (+ GH_TOKEN_VAL if
> # ENABLE_GH=true), substituting the real values
> ```

**Gate: verify all required parameters exist before proceeding** (values not
displayed) — the 4 Slack secrets plus the provider key (plus `GH_TOKEN_VAL` iff
`ENABLE_GH=true`). Only injected secrets must exist: the 4 Slack secrets are
unconditional in `secrets[]`; the provider and GitHub keys are injected only
because their matching `Enable*Key=true` was passed in Phase 2, so they're the
only ones that need to be present:

```bash
PROVIDER_KEY=$(case "$INFER_PROVIDER" in
  openrouter) echo OPENROUTER_API_KEY ;;
  anthropic)  echo ANTHROPIC_API_KEY ;;
  zai)        echo ZAI_API_KEY ;;
esac)

REQUIRED="SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_ALLOWED_USERS SLACK_HOME_CHANNEL $PROVIDER_KEY"
[ "$ENABLE_GH" = "true" ] && REQUIRED="$REQUIRED GH_TOKEN_VAL"

for k in $REQUIRED; do
  aws ssm get-parameter --name "/bclaw/$k" \
    --region "$AWS_REGION" --query 'Parameter.Name' --output text 2>&1
done
```

Every listed parameter must resolve successfully. If any returns
`ParameterNotFound`, the task will fail to fetch it and crash-loop (this only
applies to secrets that are actually injected — an opt-out key you never
enabled is `AWS::NoValue` in the task def, so its absence is fine). Do not
proceed until all of them exist.

> **Note on migration from fly.io:** the secret *values* are the same — only
> the storage location changes (fly secrets → SSM). The user can read each
> value once from `fly secrets` context (or wherever they originally sourced
> it) and write it to SSM. `fly secrets list` only shows digests, not values,
> so the user must have the originals.

---

### Phase 4: Scale the service to 1 and verify

**Gate: all required SSM parameters exist.**

Scale the service up. This starts the task; the ECS agent fetches the SSM
parameters (via the execution role's `ssm:GetParameters` grant), decrypts them
with KMS, and injects them as env vars.

```bash
aws ecs update-service \
  --cluster "$CLAW_NAME" \
  --service "$CLAW_NAME" \
  --desired-count 1 \
  --region "$AWS_REGION"
```

#### 4a. Wait for the task to reach RUNNING

Initial placement takes 2–3 minutes (mostly the ~500 MB image pull from
`ghcr.io`). Poll until the task is `RUNNING`:

```bash
aws ecs wait tasks-running \
  --cluster "$CLAW_NAME" \
  --tasks "$(aws ecs list-tasks --cluster "$CLAW_NAME" --region "$AWS_REGION" \
    --query 'taskArns[0]' --output text)" \
  --region "$AWS_REGION"
```

If you see a transient `CannotPullContainerError` in service events, don't
panic — ECS automatically stops the failed task and starts a fresh one.
Persistent failures usually mean a real problem (SG/subnet/IAM/image-not-found).

```bash
aws ecs describe-services --cluster "$CLAW_NAME" --services "$CLAW_NAME" \
  --region "$AWS_REGION" --query 'services[0].events[:5]' --output table
```

#### 4b. Report which AZ the task landed in

Confirm ARM64 placement succeeded and report the AZ:

```bash
TASK_ARN=$(aws ecs list-tasks --cluster "$CLAW_NAME" --region "$AWS_REGION" \
  --query 'taskArns[0]' --output text)

aws ecs describe-tasks --cluster "$CLAW_NAME" --tasks "$TASK_ARN" \
  --region "$AWS_REGION" \
  --query 'tasks[0].{AZ:availabilityZone, CPU:cpu, Mem:memory, Arch:runtimePlatform.cpuArchitecture, Status:lastStatus}' \
  --output table
```

Expected: `Arch = ARM64`, `Status = RUNNING`, `AZ` is one of the two from
Phase 1. If `Arch` shows `X86_64` despite `CpuArchitecture: ARM64`, the account
lacked ARM64 capacity in both AZs and Fargate fell back — inform the user.

#### 4c. Tail the gateway logs and confirm the bot connected

```bash
aws logs tail "/ecs/${CLAW_NAME}" --region "$AWS_REGION" --follow
```

Look for the Slack socket-mode connection succeeding (e.g. a "gateway started"
or "slack connected" line). You may also see an early `[gh-auth] login failed
(non-fatal)` line if the GitHub login didn't take (only when GitHub auth is
enabled — `ENABLE_GH=true`; an opt-out claw logs nothing here) — that's
non-blocking (see Phase 5a to verify/fix). `Ctrl-C` to stop following once you
see the gateway is up.

---

### Phase 5: Shell-in

**Gate: task is `RUNNING` and gateway logs show a healthy connection.**

The claw is now live. GitHub (`gh`) authentication is **automatic on boot when
enabled** (`ENABLE_GH=true`, Phase 1 step 3) — see Phase 5a below; there is no
manual auth step. To shell into the container
(uses SSM Session Manager under the hood — requires the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
locally):

```bash
TASK_ARN=$(aws ecs list-tasks --cluster "$CLAW_NAME" --region "$AWS_REGION" \
  --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster "$CLAW_NAME" --task "$TASK_ARN" \
  --container hermes --interactive --command "/bin/bash" \
  --region "$AWS_REGION"
```

> **Exec sessions run as root.** `aws ecs execute-command` opens a **root**
> shell by default, even though the gateway (PID 1) runs as the `harness` user
> (uid 1000). Prefix commands with `runuser -u harness --` to act as the
> workload user. To check the workload's actual uid from outside:
> `stat -c %u /proc/1` — `id -u` inside the exec session reports root.

#### 5a. GitHub authentication (automatic on boot)

`gh`/HTTPS-git authentication is **not** a manual step — when GitHub auth is
enabled (`ENABLE_GH=true`), the task definition injects `GH_TOKEN_VAL` from
the `/bclaw/GH_TOKEN_VAL` SSM parameter and the container `Command` runs, as
the harness user on every boot:

```
if [ -n "$GH_TOKEN_VAL" ]; then
  printf "%s" "$GH_TOKEN_VAL" | gh auth login --with-token 2>&1 \
    || echo "[gh-auth] login failed (non-fatal)"
fi
exec hermes gateway
```

The `if [ -n ... ]` guard means an opt-out claw (`ENABLE_GH=false`) skips the
login entirely — `GH_TOKEN_VAL` is never injected, so there's no spurious
`[gh-auth]` failure logged. The login is **non-fatal** when enabled: if it
fails (rejected token, GitHub outage), the failure is logged to CloudWatch as
`[gh-auth] login failed (non-fatal)` and the gateway still starts — the Slack
bot is the claw's primary function; `gh` is secondary. The session persists in
`~/.config/gh` (on EFS), and the entrypoint's `setup-env.sh` has already
seeded `GIT_CONFIG_GLOBAL` with the `gh auth git-credential` helper, so HTTPS
git operations authenticate via the same token.

**Verify it worked** (from a root exec session):

```bash
runuser -u harness -- gh auth status
```

A healthy boot shows `Logged in to github.com as <user>`. If instead you see
`not logged in`, check the logs for the `[gh-auth]` line — the token was
rejected (rotate it, see below) or GitHub was briefly unreachable (the next
task restart retries automatically).

**Rotating the token.** Update the `/bclaw/GH_TOKEN_VAL` SSM parameter in
the **AWS Console** (Systems Manager → Parameter Store → open the parameter →
**Edit** → paste the new PAT → Save), then force a new task so the boot
command re-runs the login:

```bash
aws ecs update-service --cluster "$CLAW_NAME" --service "$CLAW_NAME" \
  --force-new-deployment --region "$AWS_REGION"
```

See [harness docs → GitHub authentication](https://github.com/boldblackai/harness/blob/main/docs/github.md)
for creating a PAT and the scopes the claw's `gh`/git usage requires.

---

### Phase 6: Final report

Report to the user:

- Claw name, region, inference provider, and the AZ the task landed in (with ARM64 confirmation)
- Stack name and key outputs (cluster, EFS file system ID, SSM prefix)
- The SSM parameter locations (4 Slack + the provider key, plus `/bclaw/GH_TOKEN_VAL` if GitHub auth was enabled — values never displayed)
- GitHub auth (if enabled) is automatic on boot from `/bclaw/GH_TOKEN_VAL` (Phase 5a) — verify with `runuser -u harness -- gh auth status` from an exec session; if disabled, `gh auth status` showing "not logged in" is expected
- How to tail logs: `aws logs tail "/ecs/${CLAW_NAME}" --follow --region "$AWS_REGION"`
- How to shell in: the `aws ecs execute-command` snippet from Phase 5
- How to tear down: point at the `teardown-harness-ecs-fargate` skill

---

## Notes

- **No derived image.** This deploys the signed upstream
  `ghcr.io/boldblackai/harness` image as-is. bclaw's fly deployment used a
  custom `Dockerfile` + single-volume `entrypoint.sh` because fly allows only
  one volume per machine. ECS Fargate + EFS does **not** have that constraint
  — EFS supports multiple access points, so the upstream image's 4-way mount
  layout works directly and the fly-specific `Dockerfile`/`entrypoint.sh` are
  not needed. Do not build a derived image; see the fly deploy guide's
  "Customizing the claw" section for the rationale.

- **Secrets live in SSM, not Secrets Manager.** Following the piranesi pattern,
  secrets are namespaced SecureString parameters (`/bclaw/KEY`) that the user
  writes. The `/bclaw/` namespace is hardcoded in the template so the
  deployer IAM policy can pin `parameter/bclaw/*`. They are not
  CloudFormation resources, so stack updates never clobber their values and
  they survive stack deletes. The teardown skill deletes them explicitly after
  user confirmation. SecureStrings are encrypted with a customer-managed KMS
  key (aliased `alias/${CLAW_NAME}-ssm`) created by the template — NOT the
  default `alias/aws/ssm`. The deployer policy pins `kms:Decrypt`/`kms:Encrypt`
  to this key via `kms:ResourceAliases`. Phase 3 tells the user to select this
  key (`alias/${CLAW_NAME}-ssm`) as the KMS Key ID when creating each
  SecureString in the console.

- **The `HARNESS_CLOUD_MODE=1` entrypoint behavior.** In cloud mode,
  `/entrypoint.sh` lets hermes self-seed `config.yaml` from env vars on
  first boot — it does **not** copy from any `/etc/harness/hermes-defaults/`
  directory (that path is referenced in older deploy docs but does not exist
  for hermes; only the `pi` agent has a `cp -rn` defaults seed). To seed a
  custom `system-prompt.md` or persona, write it directly into the EFS-mounted
  `/home/harness/.hermes/` via an exec session.

- **On-boot GitHub auth via the container `Command`.** The image's ENTRYPOINT
  is `[/tini, --, /entrypoint.sh]` (verified via `/proc/1` in a running
  container) — tini is PID 1 (signal forwarding + zombie reaping), and ECS
  `Command` overrides only CMD, not ENTRYPOINT, so tini and `/entrypoint.sh`
  always run. The task definition sets no explicit `EntryPoint` (it's baked
  into the image) and no `LinuxParameters.InitProcessEnabled` (tini is the
  init — a second ECS init layer would be redundant). The `Command` wrapper is
  `if [ -n "$GH_TOKEN_VAL" ]; then printf "%s" "$GH_TOKEN_VAL" | gh auth login --with-token 2>&1 || echo "[gh-auth] login failed (non-fatal)"; fi; exec hermes gateway`,
  which the entrypoint runs via its `exec "$@"`. The entrypoint runs first
  (sources `setup-env.sh` → routes `GIT_CONFIG_GLOBAL` into persisted
  `~/.config` and seeds the `gh auth git-credential` helper; seeds
  `config.yaml`), then `exec`s the wrapper as the harness user (uid 1000). The
  login is **non-fatal** — a failure (bad token, GitHub outage) is logged to
  CloudWatch and the gateway still starts. `GH_TOKEN_VAL` is an **optional**
  SSM param (`/bclaw/GH_TOKEN_VAL`), gated behind the `EnableGitHubKey` stack
  parameter (default `false`) — the same opt-in pattern as the
  inference-provider keys (`OPENROUTER_API_KEY`, `ZAI_API_KEY`,
  `ANTHROPIC_API_KEY`), which use `EnableOpenRouterKey`/`EnableZaiKey`/
  `EnableAnthropicKey` (conditional `!If` entries in `secrets[]`; exactly one
  provider key is enabled per claw, chosen in Phase 1). When GitHub auth is
  disabled, the `Command`'s `if [ -n "$GH_TOKEN_VAL" ]` guard skips the login
  entirely and no `GH_TOKEN_VAL` is injected. The secret
  is named
  `GH_TOKEN_VAL`, **not** `GH_TOKEN`, deliberately: when the reserved `GH_TOKEN`
  env var is present, `gh auth login --with-token` refuses to store the token
  (prints "the GH_TOKEN environment variable is being used", exits 1) — a gh
  safety feature. Injecting under a non-reserved name avoids the collision so
  gh stores the credential. Storing is **necessary**, not optional: the harness
  terminal/execute_code sandbox scrubs token-like env vars from its
  environment, so `gh`/git calls the agent makes find no env var — they rely on
  the stored credential in `~/.config/gh/hosts.yml` (on EFS, persists across
  restarts). To rotate: update `/bclaw/GH_TOKEN_VAL` in the AWS console
  (Parameter Store → Edit, or `put-parameter --overwrite`) then
  `update-service --force-new-deployment` (the boot command re-runs on every
  task start). `printf` (not `echo`) is used so a token beginning with `-`
 isn't parsed as a flag, and `%s` avoids a trailing newline (gh trims
 whitespace anyway). See `references/on-boot-commands.md` for the general
 on-boot-command pattern (boot-chain diagram, the non-fatal wrapper recipe,
 and why `Command`-overrides-CMD-not-ENTRYPOINT matters).

- **EFS access points enforce uid/gid 1000.** The harness user is uid/gid
  1000 (first/only regular user in the debian:stable-slim base image). The
  access points' `PosixUser` and `CreationInfo` both pin 1000:1000, so the
  non-root gateway can write to all four mounts without any first-boot chown.
  The template also tags the file system and all 4 access points
  `Name=${ClawName}-data` so the deployer IAM policy can constrain EFS
  delete/mutate actions via `aws:ResourceTag/Name` conditions — without this,
  a `Resource: "*"` EFS statement would let the deployer delete ANY file system
  in the account. The same tag-condition pattern also covers EC2
  networking: the `EC2Networking` actions are split into `EC2Describe`
  (star, read-only), `EC2NetworkingCreate` (star, unconditional — creating
  EC2 resources is safe; see lessons doc), and `EC2NetworkingManage`
  (`aws:ResourceTag/Name: ${ClawName}*`). The
  SecurityGroup carries a `Name=${ClawName}-sg` tag for the same reason. See
  `references/iam-and-template-lessons.md` → "Least-Privilege Refactors (EC2
  Networking)" for the full rationale (including why Create and Manage must be
  separate statements) before touching the EC2 policy.

- **`EnableExecuteCommand` cannot be toggled on a running service silently.**
  The template sets it at creation. If you ever need to re-enable it after a
  manual disable, you must force a new deployment
  (`aws ecs update-service --force-new-deployment ...`) for the SSM agent
  sidecar to re-inject.

- **ARM64 AZ probe is a heuristic.** `t4g.*` availability is a strong proxy
  for Fargate ARM64 capacity, not a guarantee. The two-AZ fallback in the
  template is the real safety net — Fargate's scheduler will not place an
  ARM64 task in an AZ that can't run it; it'll use the other subnet. If both
  AZs lack capacity, switch `CpuArchitecture` to `X86_64`.

- **AWS credentials.** See Prerequisites → "AWS credentials — the deployer IAM
  user" for creating the deployer principal, the `bclaw-deploy` policy, and the
  `.env` format. `.env` is gitignored; never commit it.

- **First-task image pull.** Initial task placement takes 2–3 minutes, most of
  it the ~500 MB image pull from `ghcr.io`. A transient
  `CannotPullContainerError` in service events is normal — ECS auto-retries.
  Persistent pull failures mean the task can't reach ghcr.io (check the SG
  allows outbound, and the VPC has an internet gateway).

- **Stack updates reset DesiredCount to 0.** The template hardcodes
  `DesiredCount: 0` (safe for initial deploy — prevents crash-looping before
  secrets exist). But on a stack *update* (e.g. adding a new secret to the
  task definition), CloudFormation reverts the running count to 0, stopping
  the live task. After any stack update, re-scale:
  `aws ecs update-service --cluster "$CLAW_NAME" --service "$CLAW_NAME" --desired-count 1 --region "$AWS_REGION"`
  and wait for RUNNING. Future template improvement: make DesiredCount a
  parameter (default 0, override to 1 on updates).

- **Adding new SSM secrets.** To forward an additional SSM parameter into the
  container env, add an entry to the task definition's `secrets[]` in
  `template.yaml`, then deploy a stack update. There are two patterns,
  both already used in the template:

  - **Required (unconditional).** The 4 core Slack secrets (SLACK_*)
    are plain entries — the task fails to start if any is missing:
    ```yaml
    - { Name: FOO_KEY, ValueFrom: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/bclaw/FOO_KEY" }
    ```
  - **Optional (conditional).** `GH_TOKEN_VAL` and the inference-provider keys
    (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`) are gated behind
    an `Enable*Key` stack parameter so the template works without any given one.
    Exactly one provider key is enabled per claw (chosen in Phase 1); GitHub auth
    is opt-in via `EnableGitHubKey`. This needs three
    coordinated pieces: a `String` parameter (default `"false"`,
    `AllowedValues: ["true","false"]`), a `Conditions` entry
    (`FooKeyEnabled: !Equals [!Ref EnableFooKey, "true"]`), and a `!If` entry
    in `secrets[]`:
    ```yaml
    - !If
      - FooKeyEnabled
      - { Name: FOO_API_KEY, ValueFrom: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/bclaw/FOO_API_KEY" }
      - !Ref AWS::NoValue
    ```
    When disabled, the entry resolves to `AWS::NoValue` and ECS ignores it, so
    the task starts fine with no SSM parameter present. To enable it at deploy
    time, pass `--parameter-overrides EnableFooKey=true` (after creating the
    SSM parameter).

  The SSM parameter must exist before it's injected (create it via the AWS
  console or `put-parameter`), and the execution role's `ssm:GetParameters`
  grant already covers `parameter/bclaw/*` so no policy change is needed.
  After the stack update, re-scale to 1 (see the DesiredCount pitfall above).

- **Validating template edits.** After editing `template.yaml`, the built-in
  PyYAML linter (in `patch`/`write_file`) reports false-positive errors on
  CloudFormation intrinsic shorthand (`!Equals`, `!Sub`, `!If` — valid CFN, not
  valid plain YAML). Ignore those; instead validate with the CFN-tag-aware
  script: `python3 scripts/validate-template.py`. See
  `references/template-pitfalls.md` §11 for the full explanation.
