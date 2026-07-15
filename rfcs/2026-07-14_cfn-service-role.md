# CloudFormation service role to isolate the deployer identity

**Date:** 2026-07-14
**Status:** Implemented

## Goal

Move the broad infrastructure-create and IAM powers off the human **deployer**
identity onto a dedicated **CloudFormation service role** (`bclaw-cfn-exec`),
assumable only by CloudFormation. This closes the critical
privilege-escalation finding from the deployer-policy security review — a leaked
deployer access key is currently **root-equivalent** (full account takeover) —
and, as a side effect, closes several of the high/medium findings that share the
same root cause (broad powers sitting on the long-lived key).

The fix is the standard AWS **CloudFormation service role** pattern: a
dedicated role that CloudFormation assumes during stack operations, so broad
infra-create and IAM powers never sit on the human identity's long-lived
credentials. The deployer is reduced to stack management, secret-writing, and a
single service-conditioned `iam:PassRole`. Bclaw is a simpler consumer of the
pattern than most: it has **no operator-chosen-name roles**, so it needs the
service role **but not** the complementary permissions-boundary layer that more
dynamic deployments require (see Background).

## Motivation

### The deployer key is root-equivalent today

The deployer policy (`template/bclaw-deploy-policy.json`) is attached to a
long-lived IAM user whose access keys live in a gitignored `.env`. The security
review's headline finding (**C1**) is that those keys, if leaked (accidental
commit, laptop/CI compromise), grant **AdministratorAccess** through two
independent privilege-escalation chains. Both are viable because the only
constraint on the deployer's IAM powers is the `bclaw-*` name prefix — which the
deployer itself creates:

- **`IAMRoles`** → `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`,
  … on `arn:aws:iam::*:role/bclaw-*`
- **`IAMInstanceProfiles`** → create/delete profiles on `instance-profile/bclaw-*`
- **`PassRole`** → `iam:PassRole` on `role/bclaw-*` + `instance-profile/bclaw-*`
  with **no `iam:PassedToService` condition**

**Chain A — EC2/ASG (reuses the host-networking + public-IP path the template
already provisions):**

1. `iam:CreateRole bclaw-pwn` → `iam:PutRolePolicy` with
   `{"Action":"*","Resource":"*"}` *(an inline admin policy — locking down
   `AttachRolePolicy` alone does not close this)*
2. `iam:CreateInstanceProfile bclaw-pwn-profile` → `AddRoleToInstanceProfile`
3. `ec2:CreateLaunchTemplate` with that profile + user-data that exfiltrates IMDS
   credentials to an attacker endpoint
4. `autoscaling:CreateAutoScalingGroup` in the claw's subnet (the
   `RequestTag/ClawName=bclaw` condition is satisfied trivially — attacker
   supplies the tag)
5. The instance boots as `bclaw-pwn` (admin), host networking gives it a public
   IP, user-data exfils the instance-role creds → **full account takeover**

**Chain B — ECS (reuses the existing running service):**

1. Same admin role creation (`bclaw-pwn`)
2. `ecs:RegisterTaskDefinition` family `bclaw` with `TaskRoleArn=bclaw-pwn` +
   `iam:PassRole` (allowed, unconditioned)
3. `ecs:UpdateService --service bclaw --task-definition bclaw:<rev>` (scoped to
   `service/bclaw/*`, which already exists) → the replacement task assumes the
   admin role → takeover

Because `iam:PutRolePolicy` (inline) is granted, **narrowing `AttachRolePolicy`
does not close this** — an attacker writes an inline `Action:*,Resource:*`. The
name-prefix constraint is useless because the attacker creates the role. There is
no policy-tightening fix that leaves the deployer holding `CreateRole` +
`PutRolePolicy` on a `bclaw-*` wildcard; the powers must move off the identity.

### Secondary findings share the same root cause

Several other review findings are symptoms of broad infra powers sitting on the
long-lived key, and dissolve once those powers move onto the CFN service role:

| Finding | Statement today | Why it dissolves |
| --- | --- | --- |
| **H1** unrestricted `ec2:CreateTags` defeats every tag-scoped destructive perm | `EC2NetworkingCreate` / `EC2LaunchTemplateManage` (`CreateTags` on `*`) | `CreateTags` + the create actions move to cfn-exec; the deployer keeps only *tag-scoped deletes* (already safe) |
| **H2** `kms:PutKeyPolicy`/`DescribeKey` on `*` | `KMSCreateKey` | Key create/manage moves to cfn-exec (alias-scoped); deployer keeps only Encrypt/Decrypt via `ViaService`+`ResourceAliases` |
| **M1** `iam:PassRole` has no `PassedToService` | `PassRole` | Deployer's only PassRole becomes `bclaw-cfn-exec` → `cloudformation.amazonaws.com`; cfn-exec's PassRole is service-conditioned |
| **M2** deployer has unnecessary log-write perms | `LogsScoped` (`PutLogEvents`/`CreateLogStream`) | The `awslogs` driver authenticates via the container-instance role, not the deployer; deployer drops write |
| **M3** unconditional EC2 network create | `EC2NetworkingCreate` | Network *create* moves to cfn-exec; deployer keeps tag-scoped *manage* for teardown recovery |
| **L3** broad `RegisterTaskDefinition` is privesc surface | `ECSTaskDefsAndTasks` | Write moves to cfn-exec; deployer keeps read (`Describe`/`ListTasks`) for probing |

Findings **not** closed by this RFC (orthogonal, separate follow-ups):
**L1** (orphaned KMS key — add cleanup to teardown), **L2** (missing
`ssm:StartSession` for the documented instance debug path), **L4**
(`sts:DecodeAuthorizationMessage` on `*`), **L5** (account wildcard in ARNs).
These stay on the follow-up list regardless of this RFC's outcome.

## Background: the CFN service-role pattern

This RFC applies two standard, AWS-documented IAM patterns and explicitly skips
a third. They are layered; the first is load-bearing and the others follow from
the deployment's shape.

1. **CFN service role.** A dedicated role, created **via CLI ahead of the first
   deploy** (not CFN-owned, since the stack needs it to exist before creation),
   carries all broad infra-create powers. Every deploy passes `--role-arn`.
   The human deployer policy is reduced to stack management, SSM/KMS for
   secret-writing, read-only describes, and a single service-conditioned
   `iam:PassRole` on the literal service-role name.
2. **Permissions boundary** — for operator-chosen-name roles. When a deployment
   creates roles whose names are chosen at runtime (provisioned imperatively,
   out-of-band from the stack, not by CloudFormation), they must be capped by a
   CFN-owned managed policy. The deployer's role-creation grant is
   `iam:PermissionsBoundary`-conditioned, and a `BoundaryDeny` forbids stripping
   the boundary or mutating the boundary policy. Effective perms =
   identity-policy ∩ boundary.
3. **Every `PassRole` is `PassedToService`-conditioned** — deployer to
   `cloudformation.amazonaws.com`, service role to the downstream services it
   passes roles to.
4. **KMS split** — create/alias on the service role, use (Encrypt/Decrypt) on
   the deployer via `ViaService` + `ResourceAliases`. `PutKeyPolicy`/
   `DescribeKey` are never `*` on the deployer.

### Why bclaw needs (1), (3), (4) — but not (2)

The load-bearing distinction is whether the system creates roles with
**operator-chosen names** at runtime. A deployment that does (per-agent,
per-worker, per-tenant service roles created out-of-band from the stack) needs
a permissions boundary to cap those imperatively-created roles. **Bclaw does
not**: `bclaw-exec`, `bclaw-task`, `bclaw-instance` + instance profile are all
fixed-name and CFN-owned. Once the CFN service role is in place, the deployer
creates **zero** roles directly (it manages only the single service role by
literal name), so there is nothing to cap. Importing boundaries would add a
managed policy, a `BoundaryDeny`, and a `iam:PermissionsBoundary` condition for
no security benefit — pure complexity. This is documented explicitly so a
future "multi-claw per account" or "operator-chosen roles" feature knows to
revisit it.

## Technical Details

### The CFN service role: `bclaw-cfn-exec`

A dedicated role, created via CLI in setup **Phase 0** (idempotent),
trusted only by
`cloudformation.amazonaws.com`, carrying an inline policy with the broad
infra-create lifecycle bclaw's `template.yaml` needs: EC2 networking/volume/
launch-template create+delete, ASG CRUD, ECS cluster/service/taskdef/exec
create+update+delete, IAM role+profile create+delete on `bclaw-*`, KMS
create+manage, log-group create+delete, the autoscaling service-linked role,
and `iam:PassRole` on `bclaw-*`/`instance-profile/bclaw-*` conditioned to
`ecs-tasks.amazonaws.com`/`ec2.amazonaws.com`. Every `cloudformation deploy`
and `delete-stack` then passes `--role-arn bclaw-cfn-exec`. CloudFormation
assumes it; the deployer never touches those resources directly.

It is **not** managed by CloudFormation — it cannot be, since the stack needs
it to exist before creation. It is created in setup Phase 0 and deleted in
teardown.

### The deployer/cfn-exec permission split

Principle: **CFN lifecycle + broad infra-create + IAM → cfn-exec; human
secret-writing + operator debug + teardown recovery + tag-scoped deletes +
stack management → deployer.** Representative split of the current statements:

| Current statement | After this RFC |
| --- | --- |
| `CloudFormation` (`stack/bclaw/*`) | **Stays** on deployer; add `GetTemplateSummary`/`ValidateTemplate` on `*` (CFN metadata calls; account-global, no resource ARN) |
| `ReadOnlyDescribe` (`*` describes) | **Stays** on deployer (list calls, no resource perms) |
| `EC2NetworkingCreate` (unscoped creates + `CreateTags`) | **Moves** to cfn-exec (CFN owns the lifecycle) |
| `EC2NetworkingManage` (tag-scoped `Name=bclaw*` deletes) | **Stays** on deployer — needed for teardown Phase 4 orphaned-VPC recovery; already safe (bclaw*-scoped) |
| `EC2DataVolumeCreate` (`CreateVolume`, `RequestTag/Name=bclaw-data`) | **Moves** to cfn-exec (CFN `EbsDataVolume` resource) |
| `EC2DataVolumeManage` (`DeleteVolume`/`DetachVolume`, `Name=bclaw-data`) | **Stays** on deployer — teardown Phase 3 retained-volume cleanup, CFN can't reach it |
| `EC2InstanceOps` (`GetConsoleOutput`/`TerminateInstances`, `ClawName=bclaw`) | **Stays** on deployer — operator debug (manage-bclaw Mode 4); per the [tag-scoped RFC][tagscope] |
| `EC2LaunchTemplateManage` (`*`) | **Moves** to cfn-exec (CFN `LaunchTemplate` resource) |
| `AutoScalingCreate`/`AutoScalingManage` | **Move** to cfn-exec (CFN `AutoScalingGroup` resource) |
| `CreateAutoScalingServiceLinkedRole` | **Moves** to cfn-exec |
| `IAMRoles` (`role/bclaw-*`) | **Replaced**: deployer manages only the literal `role/bclaw-cfn-exec`; cfn-exec manages `role/bclaw-*` (exec/task/instance) |
| `IAMInstanceProfiles` (`instance-profile/bclaw-*`) | **Moves** to cfn-exec |
| `PassRole` (`role/bclaw-*`+profile, unconditional) | **Replaced**: deployer PassRole `bclaw-cfn-exec` → `cloudformation.amazonaws.com`; cfn-exec PassRole `bclaw-*`+profile → `ecs-tasks`/`ec2.amazonaws.com` |
| `ECSScoped`/`ECSExec`/`ECSTaskDefsAndTasks` | **Split**: cluster/service/taskdef *write* → cfn-exec; `ExecuteCommand`/`Describe`/`ListTasks` → deployer (shell-in + probing) |
| `SSMMessages` (`*`) | **Stays** on deployer (ECS Exec channels) |
| `DenyDirectSSMSession` | **Stays** on deployer |
| `LogsScoped` | **Split**: `Create/DeleteLogGroup`/retention → cfn-exec; read (`Describe`/`Get`/`Filter`) → deployer; **drop** `PutLogEvents`/`CreateLogStream` from deployer (awslogs uses the instance role) |
| `SSMSecrets` (`parameter/bclaw/*`) | **Stays** on deployer — the *human* writes SecureStrings outside CFN so they survive stack updates/deletes |
| `SSMPublicEcsAmi` (`aws/service/ecs/optimized-ami/*`) | **Moves** to cfn-exec — CFN resolves `!Ref EcsAmiId` (`AWS::SSM::Parameter::Value`), not the deployer |
| `KMSCreateKey` (`*`) | **Moves** to cfn-exec, split into create vs. manage: `CreateKey`/`CreateAlias`/`DeleteAlias` on the explicit alias name; `PutKeyPolicy`/`DescribeKey`/rotation via `ResourceAliases alias/bclaw-ssm` |
| `KMSUseKey` (Encrypt/Decrypt/…) | **Stays** on deployer (human writes/reads SecureStrings) + granted to cfn-exec where CFN needs it |

[tagscope]: ./2026-07-14_tag-scoped-ec2-instance-permissions.md

The exact action-level split is finalized during the integration cycle; the
principle above is what the RFC commits to.

### Setup Phase 0 (new) and teardown role-deletion

**Setup gains a Phase 0** (idempotent — created via CLI ahead of the first
deploy, since the stack needs it to exist before creation): write the trust
policy (CloudFormation may assume), `create-role bclaw-cfn-exec` if absent else
`update-assume-role-policy`, then `put-role-policy` with the inline execution
policy (idempotent overwrite). Phase 2's `cloudformation deploy` adds
`--role-arn bclaw-cfn-exec`.

**Teardown gains a final step** to delete the role. Known IAM gotcha: IAM
**refuses to delete a role that still has an inline policy attached**, so
delete the inline policy *first*, then the role:

```bash
aws iam delete-role-policy --role-name bclaw-cfn-exec --policy-name bclaw-cfn-exec
aws iam delete-role --role-name bclaw-cfn-exec
```

The role is deleted **after** the stack delete (it's needed during stack
deletion), so its removal is the final teardown step.

### Policy-size pressure relieved (secondary benefit)

The existing deployer managed policy is near the 6144-char managed-policy limit
(6111/6144 for `bclaw`, per the [tag-scoped RFC][tagscope] implementation
notes). Moving roughly half the statements onto `bclaw-cfn-exec` (an *inline*
policy, which has the more generous ~10240-char limit) relieves that pressure
and leaves headroom for future deployer-side grants.

### S3 staging bucket — not yet needed

`cloudformation deploy` needs an S3 staging bucket only when the template
exceeds 51 KB. Bclaw's `template.yaml` is ~30 KB today, so no staging bucket /
`S3Staging` permission is needed. If bclaw's template grows past 51 KB, add a
`cf-templates-*` staging bucket (create-on-first-use) to the deployer policy in
the same change.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| **CFN service role (this RFC)** | **Chosen** — moves broad powers off the long-lived key; structurally prevents the privesc chains; a standard, AWS-documented pattern. |
| **Permissions boundary** (the complement to the service-role pattern) | Rejected as unnecessary — bclaw has no operator-chosen-name roles; nothing to cap. Revisit if bclaw ever gains runtime-named roles. |
| **Tighten in place** (drop `AttachRolePolicy`, keep `PutRolePolicy`) | Rejected — does not close C1; inline-policy write is itself the escalation. Any path that leaves `CreateRole`+`PutRolePolicy` on a `bclaw-*` wildcard on the deployer is root-equivalent. |
| **Status quo** | Rejected — C1 makes the `.env` access key root-equivalent. |

## Migration Notes

- **Integration cycle required** per repo workflow. Prototype in
  `/alt/integration`:
  1. Add setup Phase 0 (create `bclaw-cfn-exec` + inline policy) and verify the
     deploy succeeds with `--role-arn`.
  2. Confirm teardown deletes the role (inline policy first).
  3. Re-run the C1 attack chains against the slimmed deployer policy and confirm
     both are now denied at the `CreateRole`/`CreateLaunchTemplate`/`PassRole`
     step (policy simulator is sufficient).
  4. Verify operator workflows still work: shell-in (`ExecuteCommand`), console
     output + terminate (manage Mode 4), retained-volume delete (teardown Phase
     3), orphaned-VPC recovery (teardown Phase 4), secret write/read.
- **Golden test** (`test/golden.test.mjs`) is unaffected in *mechanism*: the
  policy + skills still flow through the `bclaw`-only rename; the new
  `bclaw-cfn-exec` literal and the `PassedToService`/`ResourceAliases` condition
  strings contain no `bclaw` substring that needs renaming (the role name itself
  does, and is covered by the existing rename pass — confirm during port-back).
- **Port back**: edit `template/bclaw-deploy-policy.json` + the setup/teardown
  skills, then reconcile with
  `diff -rq /workspace/template /alt/integration
  --exclude=.git --exclude=.agents/skills --exclude=node_modules --exclude=dist`.
- **Existing deployments**: an in-place stack update under the new flow requires
  the operator to first run Phase 0 to create `bclaw-cfn-exec`, then re-deploy
  with `--role-arn`. Document this in the setup skill's update path.

## Implementation Notes

Implemented via integration cycle on the `otacon` stack (deployer user
`otacon-deployer`, account `660493448574`, region `us-east-1`), then ported
back to `template/`. Integration journal was discarded after port-back per the
repo workflow.

### C1 closed (both chains denied on the slimmed deployer policy)

The deployer key no longer holds `iam:CreateRole`/`PutRolePolicy`/`PassRole` on
any `otacon-*` wildcard — `CreateRole`/`PutRolePolicy` are pinned to the literal
`role/otacon-cfn-exec`, and the only `PassRole` is `otacon-cfn-exec` →
`cloudformation.amazonaws.com`. Live-tested (the deployer identity cannot run
the IAM simulator — `iam:SimulateCustomPolicy` is intentionally omitted — so
verification was live denial/allow against the real evaluated policy):

- **Chain A (EC2/ASG)** — `iam:CreateRole role/otacon-evil`,
  `iam:PutRolePolicy` on `otacon-task`/`otacon-exec`/`otacon-instance`,
  `iam:CreateInstanceProfile`, `ec2:CreateLaunchTemplate`, `autoscaling:CreateAutoScalingGroup`:
  all `UnauthorizedOperation`.
- **Chain B (ECS)** — `ecs:RegisterTaskDefinition` (both an evil family and the
  `otacon` family): `UnauthorizedOperation`. `iam:PassRole` to `ecs-tasks`/`ec2`
  is structurally impossible — granted only for `cfn-exec`→`cloudformation`.
- **Secondary findings** (`H1` unscoped `CreateTags`, `H2` `kms:CreateKey`/
  `PutKeyPolicy`/`DescribeKey`/`CreateAlias`, `M2` `logs:PutLogEvents`/
  `CreateLogGroup`, `M3` unscoped network create, `L3`
  `RegisterTaskDefinition`, `L4` `sts:DecodeAuthorizationMessage`):
  all `UnauthorizedOperation` on the slimmed deployer.

### Operator workflows intact

Verified live: stack deploy/delete with `--role-arn`; `ecs:UpdateService` (scale
— force-redeploy, setup Phase 4 / teardown Phase 1 / manage Modes 1+4); ECS read
(`DescribeServices`/`DescribeTasks`/`ListTasks`); `ecs:ExecuteCommand` (auth
passes — the Session Manager plugin is a separate local install, not a policy
concern); `manage-bclaw` Mode 4 (`GetConsoleOutput` + `TerminateInstances --dry-run`,
`ClawName`-scoped); teardown Phase 3 retained-volume delete (`DeleteVolume` →
`VolumeInUse` = auth passed); SSM secret write/read/delete + KMS decrypt via
`ResourceAliases`.

### Teardown role-deletion verified

The new final step (delete the inline policy, then the role) is correct: IAM
returns `DeleteConflict: Cannot delete entity, must delete policies first.` if
the role is deleted with the inline policy attached — proven by recreating the
role and attempting it both ways. The teardown skill runs Phase 6 (role delete)
**after** the stack delete (the role is needed during `delete-stack`).

### Verified by a full fresh CREATE + live bot

The cycle's first verification passed an UPDATE-only probe (a no-change
re-deploy that never exercises resource creation), which missed three cfn-exec
permissions the full dependency graph needs on a fresh CREATE: the logs tag
actions, the unconditional KMS key-management actions, and `ec2:RunInstances`.
Each surfaced as a distinct `CREATE_FAILED` on a from-scratch redeploy and was
fixed in `template/bclaw-cfn-exec-policy.json`. The final redeploy — fresh
`CREATE` through `bclaw-cfn-exec`, secrets written, service scaled to 1 —
resulted in a RUNNING task with a live Slack socket-mode connection. **A fresh
CREATE is the only reliable proof that cfn-exec carries the full lifecycle;
UPDATE-only probes are insufficient for a service-role port-back.**

### What changed (port-back)

- **`template/bclaw-deploy-policy.json`**: slimmed per the split table —
  removes direct `bclaw-*` IAM (except the literal `role/bclaw-cfn-exec`),
  unscoped `CreateTags`, `PutKeyPolicy`, deployer log-write
  (`PutLogEvents`/`CreateLogStream`/`CreateLogGroup`),
  `RegisterTaskDefinition`, `CreateKey`, `RunInstances` (already gone),
  `sts:DecodeAuthorizationMessage`. Keeps operator workflows: stack management
  (`+ GetTemplateSummary`/`ValidateTemplate` on `*`), tag-scoped deletes,
  `EC2InstanceOps`, `ECSServiceManage` (the deployer scales/restarts the service
  directly), `ECSExec`, `SSMMessages`, `LogsRead`, `SSMSecrets`, `KMSUseKey`,
  `ManageCfnExecRole`, `PassRoleToCfn`. Size **5881/6144** (was 8801) — headroom
  for future deployer-side grants.
- **`template/bclaw-cfn-exec-trust.json` + `bclaw-cfn-exec-policy.json`**
  (new): the service role's trust (`cloudformation.amazonaws.com` only) and
  inline execution policy (the full infra-create lifecycle). Inline policy is
  **6215** chars, under the ~10240-char inline-policy limit.
- **`setup-bclaw` skill**: new **Phase 0** (idempotent `create-role`/`update-assume-role-policy`
  - `put-role-policy`); Phase 2 deploy (and the 2-pre rollback cleanup) pass
  `--role-arn`; prerequisites note the two-role model.
- **`teardown-bclaw` skill**: Phase 2 `delete-stack` passes `--role-arn`; new
  **Phase 6** (delete inline policy, then role); verification renumbered to
  Phase 7 + adds a `cfn-exec role: gone` check.
- **`manage-bclaw` skill**: Mode 3 image-upgrade deploy passes `--role-arn`.
- **`template/README.md`**: section 2 rewritten for the two-role model (deployer
  policy + service role), with the `Resource: "*"`, tag-conditioned, and ARN-pinned
  tables updated to the slimmed statements.

### Integration-cycle issues that shaped the port-back

- **cfn-exec's `LogsLifecycle` must include the logs tag actions.** Applying a
  tag to an `AWS::Logs::LogGroup` needs `logs:TagResource`/
  `ListTagsForResource`/`UntagResource`, which the original tag-less LogGroup
  never exercised; omitting them left the stack in `UPDATE_ROLLBACK_FAILED`.
  The shipped `bclaw-cfn-exec-policy.json` carries all three.
- **cfn-exec's KMS key-management actions cannot be alias-scoped.** Scoping
  `kms:PutKeyPolicy`/`EnableKeyRotation`/`DescribeKey` to
  `kms:ResourceAliases = alias/<claw>-ssm` blocks `CreateKey`: KMS evaluates
  the caller's future ability to *administer* the key (i.e. `PutKeyPolicy`) at
  `CreateKey` time, **before the alias exists**, so the alias condition cannot
  match and `CreateKey` fails with *"The new key policy will not allow you to
  update the key policy in the future."* This was missed by the cycle's
  UPDATE-only probe (a no-change update never creates the key); it surfaced on
  the first fresh `CREATE`. The shipped `bclaw-cfn-exec-policy.json` merges the
  KMS statements into one unconditional `KMSLifecycle` statement. (The deployer
  side is unaffected — it never had these actions; `KMSUseKey`'s
  `ResourceAliases` scoping on Decrypt/Encrypt stands, since those run against
  an existing aliased key.)
- **cfn-exec's `iam:PassRole` is resource-scoped, not service-conditioned.**
  `iam:PassedToService`-conditioning the service role's PassRole to
  `ec2.amazonaws.com`/`ecs-tasks.amazonaws.com` breaks this stack's Auto Scaling
  launch-template validation (the same constraint documented in the tag-scoped
  RFC for the deployer side). The service role's PassRole is scoped to
  `role/bclaw-*` + `instance-profile/bclaw-*` with no condition; the security
  boundary is the resource scope (it can pass only the stack's own roles) plus
  the trust policy (cfn-exec is assumable only by `cloudformation.amazonaws.com`).
- **cfn-exec needs `ec2:RunInstances` (in `EC2LaunchTemplateManage`).** When a
  CloudFormation `AWS::AutoScaling::AutoScalingGroup` references a launch
  template that specifies an instance profile, the Auto Scaling handler
  pre-validates the template by checking that the caller is authorized to
  actually launch from it — and that check requires `ec2:RunInstances` (plus
  `ec2:CreateTags`, since the template's `TagSpecifications` tag instances and
  root volumes). Without it, `CreateAutoScalingGroup` fails with *"You are not
  authorized to use launch template: lt-…"*. Real instance launches still go
  through the Auto Scaling service-linked role; `RunInstances` on cfn-exec is
  only what ASG's validation checks. (The pre-RFC deployer had `RunInstances`
  unconditionally, which is why this only surfaced once the power moved to
  cfn-exec.) `RunInstances` is on cfn-exec, never on the deployer.
- **KMS auth-probe caveat.** KMS resolves a key **before** evaluating the
  identity policy for key-targeted operations, so probing `DescribeKey`/
  `PutKeyPolicy`/`CreateAlias` against a *nonexistent* key returns
  `NotFoundException` (not a Deny) and is inconclusive. Verify KMS denies
  against the **real** key ARN.
- **`ec2:DetachVolume` is pre-existing-broken on the deployer** (the
  `aws:ResourceTag/Name=otacon-data` condition matches only the volume side of
  a two-resource `DetachVolume` call). Byte-identical in the pre-RFC broad
  policy, so not a regression — flagged as an orthogonal follow-up (same
category as L1/L2/L4/L5), not fixed here.

### Orthogonal follow-ups (separate RFCs)

`L1` (orphaned KMS key — add cleanup to teardown), `L2` (missing
`ssm:StartSession` for the documented instance debug path), `L4`
(`sts:DecodeAuthorizationMessage` on `*`), `L5` (account wildcard in ARNs), and
the `DetachVolume` multi-resource tag mismatch noted above.
