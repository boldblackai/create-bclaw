---
name: teardown-bclaw
description: >
  Tears down a Hermes Agent bclaw on ECS Fargate and all associated AWS
  resources. Follows a reverse-order sequence: scale to 0 → delete
  CloudFormation stack → delete retained EFS → delete orphaned VPC → delete
  SSM secrets. Use when
  asked to destroy, teardown, or decommission the bclaw. Companion to
  setup-bclaw.
---

# Teardown Harness ECS Fargate

Tears down a Hermes Agent claw on ECS Fargate. Follows the reverse order of
setup so dependencies delete cleanly without orphans. The CloudFormation stack
owns the VPC, EFS, ECS service/task/cluster, IAM roles, and log group —
deleting the stack removes all of them. Two resources survive a stack delete
and need explicit cleanup: EFS data is retained by `DeletionPolicy: Retain`
(Phase 3), and the VPC plus networking can be skipped when the stack delete
hits `FORCE_DELETE_STACK` (Phase 4). SSM secrets are not stack-owned and are
deleted separately.

## Prerequisites

Before starting, ensure the shell has `mise`, `direnv`, and AWS credentials
loaded (same as setup):

```bash
eval "$(/usr/local/bin/mise activate bash)" \
  && eval "$(direnv hook bash)" \
  && cd /workspace \
  && eval "$(direnv export bash)"
```

All `aws` commands in this skill assume this shell state.

**Confirm intent.** Use `ask_user_question` to confirm the user wants to
destroy the claw. This is destructive and irreversible — all EFS data
(sessions, memories, skills, the faster-whisper model cache, gh credentials)
will be lost unless the user backs it up first.

Also collect the **claw name** (default `bclaw`) and **region** (default
`us-east-1`) via `ask_user_question`. Store as:

```bash
CLAW_NAME=<user-provided>
AWS_REGION=<user-provided>
```

## Teardown Sequence

Follow these phases **in order**. Each phase has a gate that must be satisfied
before proceeding.

---

### Phase 0: Pre-flight — confirm AWS access

**Gate: `aws sts get-caller-identity` succeeds.**

Confirm the shell's AWS credentials are live and identify the principal that
will run the deletes:

```bash
aws sts get-caller-identity --query 'Arn' --output text
```

Teardown is self-correcting: a failed delete leaves the resource behind and
Phase 6's verification catches any leftovers, so real permission gaps surface
as the phases run rather than up front.

---

### Phase 1: Scale the service to 0

**Gate: user confirmed intent.**

Stop the running task before touching the stack, so the gateway shuts down
cleanly (flushes session state) instead of being killed mid-write.

```bash
aws ecs update-service \
  --cluster "$CLAW_NAME" \
  --service "$CLAW_NAME" \
  --desired-count 0 \
  --region "$AWS_REGION"
```

Wait for the service to reach 0 running tasks:

```bash
# services-inactive waits for status INACTIVE (only set by DeleteService);
# scale-to-0 only drains runningCount. Poll that directly instead.
for i in $(seq 1 30); do
  RUNNING=$(aws ecs describe-services \
    --cluster "$CLAW_NAME" \
    --services "$CLAW_NAME" \
    --region "$AWS_REGION" \
    --query 'services[0].runningCount' --output text)
  echo "[$((i*10))s] runningCount=$RUNNING"
  [ "$RUNNING" = "0" ] && break
  sleep 10
done
[ "$RUNNING" = "0" ] || echo "still draining — fall through to stop-task"
```

If the wait times out (a task stuck in `STOPPING`), force it:

```bash
aws ecs stop-task \
  --cluster "$CLAW_NAME" \
  --task "$(aws ecs list-tasks --cluster "$CLAW_NAME" --region "$AWS_REGION" \
    --query 'taskArns[0]' --output text)" \
  --region "$AWS_REGION"
```

---

### Phase 2: Delete the CloudFormation stack

**Gate: service is at 0 running tasks.**

Delete the stack. This removes the service, task definition family's inactive
revisions, cluster, IAM roles (exec + task), log group, EFS access points +
mount targets + file system (subject to the retain policy — see Phase 3),
security group, subnets, route table, internet gateway, and VPC. If the stack
delete skipped the networking (the `FORCE_DELETE_STACK` path can, when EFS
mount-target ENIs block subnet deletion), Phase 4 sweeps the orphaned VPC.

```bash
aws cloudformation delete-stack \
  --stack-name "$CLAW_NAME" \
  --region "$AWS_REGION"
```

Wait for `DELETE_COMPLETE`:

```bash
aws cloudformation wait stack-delete-complete \
  --stack-name "$CLAW_NAME" \
  --region "$AWS_REGION"
```

**Common delete failures and how to force-clean them:**

- **`DELETE_FAILED`: CloudFormation can't confirm deletion of already-gone
  resources.** The stack delete can fail not because a resource still exists,
  but because CloudFormation's handler can't confirm a resource that's already
  gone. Two manifestations observed on this deployer policy:
  - **EFS mount targets (403).** The handler fails to clear them even though
    direct CLI calls (`describe-mount-targets`, `delete-file-system`) succeed
    under the same principal — EFS delete permissions are tag-conditioned
    (`aws:ResourceTag/Name: bclaw-data`) and don't evaluate identically through
    CloudFormation's handler. Verify they're gone with
    `aws efs describe-mount-targets` per FS (deployer CAN do this via CLI).
  - **IAM roles (`NoSuchEntity`).** The exec/task roles (`bclaw-*`) can be
    deleted out from under the handler (e.g. a prior partial teardown), so the
    handler 404s confirming a resource that no longer exists. Verify with
    `aws iam get-role` for each `bclaw-*` role (returns `NoSuchEntity` if gone).
  In both cases the resources are confirmed gone via direct CLI, but the stack
  is stuck on handler confirmation. Fix: re-run `delete-stack` with
  `--deletion-mode FORCE_DELETE_STACK` (requires `cloudformation:DeleteStack`
  with the force capability). This skips resources that fail and continues
  deleting the rest.

- **Multiple retained EFS file systems.** If the stack was updated multiple
  times, each update may have replaced the EFS resource (creating a new one
  and retaining the old via `DeletionPolicy: Retain`). Check for ALL file
  systems tagged `bclaw-data`, not just one, and delete them all in Phase 3.

- **EFS file system retained.** `EFSFileSystem` has `DeletionPolicy: Retain`
  to protect data, so the stack delete leaves it behind. Phase 3 deletes it
  explicitly after the user confirms. Capture its ID first:

  ```bash
  EFS_ID=$(aws efs describe-file-systems \
    --region "$AWS_REGION" \
    --query 'FileSystems[?Tags[?Key==`Name` && Value==`'"${CLAW_NAME}"'-data`]].FileSystemId' \
    --output text)
  echo "EFS to delete (Phase 3): $EFS_ID"
  ```

- **Cluster not empty / service still draining.** Re-run Phase 1's
  `stop-task`, then retry `delete-stack`.

---

### Phase 3: Delete the retained EFS file system

**Gate: stack is `DELETE_COMPLETE`; user confirms data loss is OK.**

The EFS file system was retained by the stack to protect data. Now delete it.
First confirm no mount targets remain (the stack delete should have removed
them, but verify):

```bash
aws efs describe-mount-targets \
  --file-system-id "$EFS_ID" \
  --region "$AWS_REGION" \
  --query 'MountTargets[].MountTargetId' --output text
```

If any mount targets are listed, wait for them to delete:

```bash
aws efs wait mount-targets-deleted --file-system-id "$EFS_ID" --region "$AWS_REGION"
```

Then delete the file system:

```bash
aws efs delete-file-system \
  --file-system-id "$EFS_ID" \
  --region "$AWS_REGION"
```

> **Skip this phase** if the user wants to keep EFS data (e.g. for a future
> redeploy with the same sessions/memories). The file system survives
> indefinitely; note its ID so setup can re-attach by importing it.

> **EFS delete permissions are tag-conditioned, not absent.** The deployer
> policy scopes EFS delete via `aws:ResourceTag/Name: bclaw*`, so file
> systems tagged `Name=bclaw-data` (all of them, regardless of which stack
> version created them) are within scope. Try the `delete-file-system`
> command directly. If it fails with `AccessDeniedException`, note the file
> system IDs in the final report for manual console cleanup. To delete
> multiple retained EFS orphans, loop over all IDs returned by the
> `describe-file-systems` tag query in Phase 2.

---

### Phase 4: Delete the orphaned VPC and networking

**Gate: stack is `DELETE_COMPLETE` (Phase 2); EFS handled (Phase 3, done or skipped).**

The VPC, subnets, route table, internet gateway, and security group are
stack-owned, so a clean stack delete removes them. They survive only when the
stack delete skipped them — the `FORCE_DELETE_STACK` recovery path skips any
resource whose delete fails, and the usual cause is EFS mount-target ENIs
blocking subnet deletion. Once Phase 3 deletes the file system (and with it the
mount targets + their ENIs), the networking is unblocked and the orphaned VPC
can be removed.

Find the VPC by its `Name` tag:

```bash
VPC_ID=$(aws ec2 describe-vpcs \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${CLAW_NAME}-vpc" \
  --query 'Vpcs[].VpcId' --output text)

if [ -z "$VPC_ID" ]; then
  echo "vpc: gone (stack delete cleaned it up)"
else
  echo "vpc: ORPHANED ($VPC_ID) — removing"
fi
```

If `VPC_ID` is empty, the stack delete handled the VPC — skip the rest of this
phase. Otherwise, delete the VPC's dependencies in dependency order, then the
VPC. Each delete is tag-scoped to the claw's resources and tolerates resources
that are already gone:

```bash
# Subnets — deleting a subnet clears its route-table associations
for s in $(aws ec2 describe-subnets --region "$AWS_REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'Subnets[].SubnetId' --output text); do
  aws ec2 delete-subnet --subnet-id "$s" --region "$AWS_REGION" \
    && echo "subnet deleted: $s" || echo "subnet left: $s"
done

# Custom route table (the VPC's main route table is removed with the VPC)
for rt in $(aws ec2 describe-route-tables --region "$AWS_REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text); do
  aws ec2 delete-route-table --route-table-id "$rt" --region "$AWS_REGION" \
    && echo "route table deleted: $rt" || echo "route table left: $rt"
done

# Internet gateway — detach, then delete
for igw in $(aws ec2 describe-internet-gateways --region "$AWS_REGION" \
    --filters "Name=attachment.vpc-id,Values=$VPC_ID" \
    --query 'InternetGateways[].InternetGatewayId' --output text); do
  aws ec2 detach-internet-gateway --internet-gateway-id "$igw" \
    --vpc-id "$VPC_ID" --region "$AWS_REGION" || true
  aws ec2 delete-internet-gateway --internet-gateway-id "$igw" \
    --region "$AWS_REGION" \
    && echo "internet gateway deleted: $igw" || echo "internet gateway left: $igw"
done

# Security group (skip the VPC default — it is removed with the VPC)
for sg in $(aws ec2 describe-security-groups --region "$AWS_REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[?GroupName!=`default`].GroupId' --output text); do
  aws ec2 delete-security-group --group-id "$sg" --region "$AWS_REGION" \
    && echo "security group deleted: $sg" || echo "security group left: $sg"
done

# The VPC
aws ec2 delete-vpc --vpc-id "$VPC_ID" --region "$AWS_REGION" \
  && echo "vpc deleted: $VPC_ID" || echo "vpc STILL EXISTS: $VPC_ID"
```

> **A lingering network interface blocks the chain.** `delete-subnet` fails with
> a dependency error if any ENI remains in it. After scaling to 0 (Phase 1) and
> deleting EFS (Phase 3) there should be none, but a stuck Fargate task ENI can
> persist. The deployer policy does not grant `ec2:DeleteNetworkInterface` —
> Fargate ENIs are not claw-tagged, so the action cannot be tag-scoped safely.
> Delete a stuck ENI from the console, then re-run this sweep.

> **The deployer can delete only claw-tagged networking.** Every resource deleted
> above carries a `Name=bclaw*` tag, which is what the policy's
> `EC2NetworkingManage` statement (`aws:ResourceTag/Name: bclaw*`) keys on. The
> read-only `Describe*` calls are unscoped, so finding the VPC always works; the
> deletes succeed only against the claw's own resources.

---

### Phase 5: Delete the SSM secrets

**Gate: stack deleted (Phase 2); EFS handled (Phase 3, skipped or done).**

The SSM parameters are not stack-owned, so they survive the stack delete. Delete
them now. `ssm delete-parameter` is immediate and irreversible (no recovery
window — that only applies to Secrets Manager).

> **The deployer policy grants the deletes directly.** Its `SSMSecrets`
> statement allows `ssm:DeleteParameter` on
> `arn:aws:ssm:*:*:parameter/bclaw/*`, so the deletes below succeed without a
> console fallback. Only fall back to console cleanup if a delete fails with
> `AccessDeniedException` for a param outside that ARN scope.

```bash
# Delete ALL params under /bclaw/ — covers whichever provider key
# (OPENROUTER_API_KEY | ANTHROPIC_API_KEY | ZAI_API_KEY) this deploy used.
# The namespace is one-claw-per-account, so this is the full secret set.
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/bclaw/" \
  --region "$AWS_REGION" \
  --query 'Parameters[].Name' --output text | tr '\t' '\n' | while read -r p; do
  [ -n "$p" ] || continue
  if aws ssm delete-parameter --name "$p" --region "$AWS_REGION"; then
    echo "deleted: $p"
  else
    echo "(already gone: $p)"
  fi
done
```

Verify the namespace is empty:

```bash
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/bclaw/" \
  --region "$AWS_REGION" \
  --query 'Parameters[].Name' --output table
```

Expected: an empty list.

---

### Phase 6: Final verification and report

Confirm nothing is left under the claw's name:

```bash
# No remaining stacks
aws cloudformation describe-stacks \
  --stack-name "$CLAW_NAME" \
  --region "$AWS_REGION" 2>&1 | grep -q "does not exist" \
  && echo "stack: gone" || echo "stack: STILL EXISTS"

# No remaining EFS
aws efs describe-file-systems --region "$AWS_REGION" \
  --query 'FileSystems[?Tags[?Key==`Name` && Value==`'"${CLAW_NAME}"'-data`]]' \
  --output text | grep -q . \
  && echo "efs: STILL EXISTS" || echo "efs: gone"

# No remaining VPC
aws ec2 describe-vpcs --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${CLAW_NAME}-vpc" \
  --query 'Vpcs[].VpcId' --output text | grep -q . \
  && echo "vpc: STILL EXISTS" || echo "vpc: gone"

# No remaining SSM params
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/bclaw/" \
  --region "$AWS_REGION" --query 'Parameters[].Name' --output text | grep -q . \
  && echo "ssm: STILL EXISTS" || echo "ssm: gone"
```

Report to the user:
- Stack status (gone)
- EFS status (gone, or retained ID if they chose to keep it)
- VPC + networking status (gone, or leftover IDs if an ENI blocked deletion)
- SSM parameters status (gone)
- Reminder that the Slack app config (bot/app tokens, allowed users, home
  channel) still exists on the Slack side and can be reused for a future deploy

---

## Notes

- **EFS `DeletionPolicy: Retain` is deliberate.** The setup template retains
  the file system on stack delete to protect sessions/memories/skills from
  accidental loss. This teardown skill deletes it explicitly in Phase 3 only
  after the user confirms. If you want stack-delete to also nuke EFS, change
  `DeletionPolicy` to `Delete` in `template.yaml` — but the retain default is
  safer.

- **Task definition revisions are not deleted by `delete-stack`.** ECS keeps
  inactive task definition revisions. `delete-stack` removes the service but
  the task definition family's old revisions linger (harmless, no cost). They
  can be cleaned with `aws ecs deregister-task-definition` per revision, but
  it's not necessary for a clean teardown.

- **SSM has no recovery for `delete-parameter`.** Unlike Secrets Manager
  (7-day recovery window by default), `ssm delete-parameter` is immediate and
  irreversible. If the user might redeploy, have them record the values before
  Phase 4 — they'll need to re-write them during setup.

- **The SSM namespace is hardcoded (`/bclaw/`), not derived from `ClawName`.** Secrets live at
  `/bclaw/<KEY>` so the deployer's IAM policy can be scoped to
  `parameter/bclaw/*` (see the setup skill's Phase 0). With one claw per
  account, Phase 5 deleting `/bclaw/*` removes the account's entire secret
  set — correct for a full teardown.

- **Order matters.** Always scale to 0 (Phase 1) before deleting the stack
  (Phase 2). Deleting the stack while the task is running can leave the EFS
  mount in a busy state, blocking file-system deletion in Phase 3. The VPC
  sweep (Phase 4) runs after the EFS delete (Phase 3) for the same reason:
  EFS mount-target ENIs block subnet/VPC deletion until the mount targets are
  gone.
