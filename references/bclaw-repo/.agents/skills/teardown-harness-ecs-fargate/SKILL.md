---
name: teardown-harness-ecs-fargate
description: >
  Tears down a Hermes Agent claw on ECS Fargate and all associated AWS
  resources. Follows a reverse-order sequence: scale to 0 → delete
  CloudFormation stack (VPC, EFS, ECS, IAM) → delete SSM secrets. Use when
  asked to destroy, teardown, or decommission the claw. Companion to
  setup-harness-ecs-fargate.
---

# Teardown Harness ECS Fargate

Tears down a Hermes Agent claw on ECS Fargate. Follows the reverse order of
setup so dependencies delete cleanly without orphans. The CloudFormation stack
owns the VPC, EFS, ECS service/task/cluster, IAM roles, and log group —
deleting the stack removes all of them. EFS data is retained by the stack's
`DeletionPolicy: Retain` and must be deleted explicitly. SSM secrets are not
stack-owned and are deleted separately.

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

### Phase 0: Pre-flight — verify teardown permissions

**Gate: `simulate-principal-policy` shows no `denied` delete actions.**

Mirror of the setup skill's Phase 0, scoped to the **delete** action set.
Avoids a half-torn-down stack when the principal lacks a delete permission
mid-way through. Get the caller ARN and simulate:

> **Caveat: `simulate-principal-policy` is unreliable in BOTH directions
> for this deployer policy unless called with `--context-entries` for tag
> conditions.** The deployer policy uses two different scoping mechanisms:
>
> - **ARN-scoped** (VPC/subnet/SG): the policy pins specific physical ARNs
>   from the latest stack deployment. Without `--resource-arns`, the
>   simulator tests at `*` scope and **overestimates** — shows "allowed"
>   when the actual resources from earlier stacks have different ARNs and
>   are truly outside scope. These resources CAN'T be deleted by the
>   deployer.
> - **Tag-conditioned** (EFS delete/manage via `aws:ResourceTag/Name:
>   bclaw*`): without `--context-entries`, the simulator **underestimates**
>   — returns `implicitDeny` because it can't evaluate the tag condition.
>   But the actual API calls work: `describe-file-systems` and
>   `describe-mount-targets` succeed despite the false simulate denial.
>   Retained EFS orphans tagged `Name=bclaw-data` ARE within the tag scope
>   and are likely deletable — do NOT assume "can't delete" from the bare
>   simulate alone. Try the actual operation.
> - **SSM is truly denied** (zero SSM actions in the policy) — this is a
>   real `implicitDeny`, not a tag-condition false negative.
>
> The query below uses `EvalDecision!=\`allowed\`` (catches both
> `explicitDeny` and `implicitDeny`) WITH `--context-entries` so
> tag-conditioned EFS/EC2 actions evaluate correctly. Even so, treat the
> gate as necessary but not sufficient — when the simulate and the actual
> API behavior disagree, trust the API.

```bash
CALLER_ARN=$(aws sts get-caller-identity --query 'Arn' --output text)

aws iam simulate-principal-policy \
  --policy-source-arn "$CALLER_ARN" \
  --action-names \
      cloudformation:DeleteStack cloudformation:DescribeStacks \
      ecs:UpdateService ecs:DeleteService ecs:DeleteCluster ecs:StopTask \
      ecs:DescribeServices ecs:DescribeClusters ecs:ListTasks \
      elasticfilesystem:DeleteFileSystem elasticfilesystem:DeleteAccessPoint \
      elasticfilesystem:DeleteMountTarget elasticfilesystem:DescribeMountTargets \
      iam:DeleteRole iam:DeleteRolePolicy iam:DetachRolePolicy \
      iam:GetRole iam:ListRolePolicies iam:ListAttachedRolePolicies \
      ec2:DeleteVpc ec2:DeleteSubnet ec2:DeleteSecurityGroup \
      ec2:DeleteInternetGateway ec2:DetachInternetGateway \
      ec2:DeleteRouteTable ec2:DisassociateRouteTable ec2:DeleteRoute \
      ec2:DescribeVpcs ec2:DescribeSubnets ec2:DescribeSecurityGroups \
      logs:DeleteLogGroup logs:DescribeLogGroups \
      ssm:DeleteParameter ssm:DescribeParameters \
  --context-entries \
    '[{"ContextKeyName":"aws:ResourceTag/Name","ContextKeyType":"string","ContextKeyValues":["bclaw-data"]}]' \
  --query 'EvaluationResults[?EvalDecision!=`allowed`].EvalActionName' --output text | tr '\t' '\n'
```

Empty output → proceed. Any action listed → check whether it's expected:

- **`ssm:DeleteParameter` / `ssm:DescribeParameters`**: expected — the
  deployer policy has zero SSM actions (Phase 4 handles this via console
  fallback). Proceed; do not treat as a blocker.
- **EFS actions** (`elasticfilesystem:Delete*` / `DescribeMountTargets`):
  should NOT appear — the `--context-entries` above provides the tag
  condition. If they do, the policy may have changed; try the actual
  operation before assuming denial (see Phase 0 caveat above).
- **Any other action**: real gap. Abort and tell the user which permissions
  to add (the `bclaw-deploy` policy in the README already covers teardown;
  point the user there if they never attached it).

> If `iam:SimulatePrincipalPolicy` is itself denied, skip the simulation and
> proceed to Phase 1 — the delete operations will surface real errors if any
> permission is missing. Teardown is somewhat self-correcting (a failed delete
> leaves the resource behind and Phase 5's verification catches it).

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
aws ecs wait services-inactive \
  --cluster "$CLAW_NAME" \
  --services "$CLAW_NAME" \
  --region "$AWS_REGION"
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
security group, subnets, route table, internet gateway, and VPC.

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

- **EFS mount targets fail with 403.** CloudFormation's resource handler
  uses the caller's credentials, and can fail to clear EFS mount targets
  even though direct CLI calls (`describe-mount-targets`,
  `delete-file-system`) succeed under the same principal — the deployer's
  EFS permissions are tag-conditioned and may not evaluate identically
  through CloudFormation's handler. If the mount targets are already gone
  (verify with `aws efs describe-mount-targets` per FS — deployer CAN do
  this directly via CLI), the stack is stuck only because CloudFormation
  can't confirm the deletion. Fix: re-run `delete-stack` with
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
    --query 'FileSystems[?Tags[?Key==`Name` && Value==`${CLAW_NAME}-data`]].FileSystemId' \
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
> version created them) are within scope. `simulate-principal-policy`
> returns false `implicitDeny` for these without `--context-entries` (see
> Phase 0 caveat) — do NOT preemptively route to console based on the bare
> simulate. Try the `delete-file-system` command directly. If it fails with
> `AccessDeniedException`, note the file system IDs in the final report for
> manual console cleanup (same pattern as Phase 4 SSM fallback). To delete
> multiple retained EFS orphans, loop over all IDs returned by the
> `describe-file-systems` tag query in Phase 2.

---

### Phase 4: Delete the SSM secrets

**Gate: stack deleted (Phase 2); EFS handled (Phase 3, skipped or done).**

The SSM parameters are not stack-owned, so they survive the stack delete. Delete
them now. Use `--force-delete-without-recovery` for immediate deletion (the
default is a 7-day recovery window).

> **The deployer IAM user may lack `ssm:DeleteParameter` entirely.** The SSM
> params are created by the user with admin credentials during setup Phase 3
> (piranesi pattern), and the deployer's policy may not include any SSM
> actions. If the delete fails with `AccessDeniedException`, note the 6
> parameter names in the final report for manual console cleanup instead of
> treating it as a skill failure.

```bash
for k in OPENROUTER_API_KEY SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_ALLOWED_USERS SLACK_HOME_CHANNEL GH_TOKEN_VAL; do
  aws ssm delete-parameter \
    --name "/bclaw/$k" \
    --region "$AWS_REGION" 2>&1 || echo "(already gone: /bclaw/$k)"
done
```

Verify all 6 are gone:

```bash
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/bclaw/" \
  --region "$AWS_REGION" \
  --query 'Parameters[].Name' --output table
```

Expected: an empty list.

---

### Phase 5: Final verification and report

Confirm nothing is left under the claw's name:

```bash
# No remaining stacks
aws cloudformation describe-stacks \
  --stack-name "$CLAW_NAME" \
  --region "$AWS_REGION" 2>&1 | grep -q "does not exist" \
  && echo "stack: gone" || echo "stack: STILL EXISTS"

# No remaining EFS
aws efs describe-file-systems --region "$AWS_REGION" \
  --query 'FileSystems[?Tags[?Key==`Name` && Value==`${CLAW_NAME}-data`]]' \
  --output text | grep -q . \
  && echo "efs: STILL EXISTS" || echo "efs: gone"

# No remaining SSM params
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/bclaw/" \
  --region "$AWS_REGION" --query 'Parameters[].Name' --output text | grep -q . \
  && echo "ssm: STILL EXISTS" || echo "ssm: gone"
```

Report to the user:
- Stack status (gone)
- EFS status (gone, or retained ID if they chose to keep it)
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
  account, Phase 4 deleting `/bclaw/*` removes the account's entire secret
  set — correct for a full teardown.

- **Order matters.** Always scale to 0 (Phase 1) before deleting the stack
  (Phase 2). Deleting the stack while the task is running can leave the EFS
  mount in a busy state, blocking file-system deletion in Phase 3.
