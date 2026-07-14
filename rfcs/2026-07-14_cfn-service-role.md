# CloudFormation service role to isolate the deployer identity

**Date:** 2026-07-14
**Status:** Proposed

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

## Implementation Checklist

- [ ] **Integration cycle** in `/alt/integration`:
  - [ ] Draft the `bclaw-cfn-exec` trust + inline execution policy (EC2/ASG/ECS/IAM/KMS/logs/PassRole lifecycle).
  - [ ] Slim `otacon-deploy-policy.json` per the split table; remove direct `bclaw-*` IAM, unscoped `CreateTags`, `PutKeyPolicy`, deployer log-write, `RegisterTaskDefinition`.
  - [ ] Add setup Phase 0 (idempotent role + inline policy); add `--role-arn` to the deploy.
  - [ ] Add teardown step (delete inline policy, then role).
  - [ ] Verify both C1 chains are denied (policy simulator); verify operator workflows intact.
- [ ] Port back to `template/`: `bclaw-deploy-policy.json`, setup-bclaw Phase 0 + Phase 2 `--role-arn`, teardown-bclaw role-deletion step.
- [ ] Update `template/README.md` permissions section to describe the service-role split.
- [ ] Run `pnpm lint` and the golden test; reconcile the diff.
- [ ] Note orthogonal follow-ups (L1 KMS teardown cleanup, L2 `ssm:StartSession`) for separate RFCs.
