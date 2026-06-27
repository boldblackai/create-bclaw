# IAM Permission Gaps and Template Fixes

Lessons from a real deployment of the bclaw claw (June 2026). Each entry
documents a gap discovered through iterative deployment failures, with the
specific AWS error and the fix. The canonical policy in SKILL.md and the
concrete copy at `/workspace/bclaw-deploy-policy.json` have been updated to
include all these fixes — this file exists to explain *why* each permission
and template fix is needed, so future sessions don't remove them.

## IAM Policy Gaps (bclaw-deploy-policy.json)

The original canonical policy was missing several permissions that
CloudFormation needs during stack creation and updates. Each was discovered
through a deployment failure.

### cloudformation:DescribeChangeSet
- **Error**: `AccessDenied` on `DescribeChangeSet` during `aws cloudformation deploy`
- **Why**: `deploy` creates a change set, then polls `DescribeChangeSet` to
  check its status before executing it.
- **Fix**: Added to the CloudFormation statement.

### cloudformation:GetTemplateSummary
- **Error**: `AccessDenied` on `GetTemplateSummary` during `aws cloudformation deploy`
- **Why**: `deploy` calls `GetTemplateSummary` to analyze the template before
  creating a change set. Needed for both initial deploy and stack updates.
- **Fix**: Added to the CloudFormation statement.

### CloudFormation stack ARN: stack/bclaw → stack/bclaw/*
- **Error**: `AccessDenied` on `DescribeStacks` — resource ARN didn't match
- **Why**: CloudFormation stack ARNs include a UUID suffix
  (e.g. `stack/bclaw/abc123-def`). The pattern `stack/bclaw` doesn't match.
- **Fix**: Changed to `stack/bclaw/*`.

### cloudformation:ContinueUpdateRollback
- **Error**: `AccessDenied` on `ContinueUpdateRollback` when recovering a
  stuck `UPDATE_ROLLBACK_FAILED` stack state.
- **Why**: If a stack update partially fails (some resources update, others
  don't) and the automatic rollback *also* fails, the stack enters
  `UPDATE_ROLLBACK_FAILED` — a terminal state that blocks all further
  updates. The only programmatic recovery is
  `aws cloudformation continue-update-rollback` (optionally with
  `--resources-to-skip` for resources that are already in their target state).
  Without `cloudformation:ContinueUpdateRollback` in the deployer policy, the
  stack is permanently stuck and can only be recovered by a privileged
  administrator — the deployer principal has no path forward.
- **Fix**: Added `cloudformation:ContinueUpdateRollback` to the
  CloudFormation statement in `bclaw-deploy-policy.json`.
- **Recovery procedure** (see also Operational Notes below):
  1. `continue-update-rollback --resources-to-skip <LogicalId>` to clear the
     stuck state (skip any resource that failed during rollback — it's
     already in its original/target state, CFN just needs to stop retrying).
  2. The stack returns to `UPDATE_ROLLBACK_COMPLETE`, which is a usable state
     (not `UPDATE_COMPLETE`, but you can re-initiate an update from it).
  3. Fix the root cause, then `update-stack` (or `deploy`) again.
  - **Waiter gotcha**: `aws cloudformation wait stack-update-complete` treats
    `UPDATE_ROLLBACK_COMPLETE` as a *failure* (it only matches
    `UPDATE_COMPLETE`). After a `continue-update-rollback`, don't use that
    waiter to poll for rollback completion — check `describe-stacks
    --query StackStatus` directly, or accept the waiter error as success
    when the stack is in `UPDATE_ROLLBACK_COMPLETE`.

### ec2:DescribeInstanceTypeOfferings
- **Error**: `UnauthorizedOperation` when probing ARM64 AZs (Phase 1)
- **Why**: Phase 1's ARM64 AZ probe uses `describe-instance-type-offerings`.
- **Fix**: Added to the EC2Networking statement.

### ec2:ModifySubnetAttribute
- **Error**: `AccessDenied` on `ModifySubnetAttribute` during subnet creation
- **Why**: The template sets `MapPublicIpOnLaunch` on subnets, which requires
  `ec2:ModifySubnetAttribute`.
- **Fix**: Added to the EC2Networking statement.

### logs:PutRetentionPolicy
- **Error**: `The specified log group does not exist` during LogGroup creation
- **Why**: The LogGroup resource has `RetentionInDays: 14`, which triggers a
  `PutRetentionPolicy` call after creation.
- **Fix**: Added to the LogsScoped statement.

### logs:FilterLogEvents, logs:GetLogEvents
- **Error**: `AccessDenied` when running `aws logs tail`
- **Why**: `aws logs tail` uses `FilterLogEvents` under the hood. Needed for
  Phase 4c (tail gateway logs) and general log reading.
- **Fix**: Added to the LogsScoped statement.

### kms:PutKeyPolicy
- **Error**: `The new key policy will not allow you to update the key policy in
  the future`
- **Why**: AWS validates that the calling principal can update the key policy
  after creation. The key policy grants `kms:*` to the account root, but the
  calling IAM user needs `kms:PutKeyPolicy` in its identity-based policy too.
- **Fix**: Added to the KMSCreateKey statement (unconstrained — one-time setup).

### kms:EnableKeyRotation (moved from KMSUseKey to KMSCreateKey)
- **Error**: `Access denied for operation 'EnableKeyRotation'` during key
  creation
- **Why**: The template sets `EnableKeyRotation: true`, so CloudFormation calls
  `EnableKeyRotation` during key creation. At that point the KMS alias
  (`alias/bclaw-ssm`) doesn't exist yet — it's a separate resource that depends
  on the key. The KMSUseKey statement's `kms:ResourceAliases = alias/bclaw-ssm`
  condition blocked the call.
- **Fix**: Moved from KMSUseKey (alias-conditioned) to KMSCreateKey
  (unconstrained). One-time setup operation.

### kms:DescribeKey (added to KMSCreateKey)
- **Error**: `Unable to retrieve Arn attribute for AWS::KMS::Key, with error
  message Access denied for operation 'DescribeKey'`
- **Why**: CloudFormation needs `kms:DescribeKey` to resolve
  `!GetAtt SsmKmsKey.Arn` when creating the ExecutionRole (which references the
  key ARN in its inline policy). At that point the alias doesn't exist yet, so
  the alias condition in KMSUseKey blocked it.
- **Fix**: Added to KMSCreateKey (unconstrained). Also remains in KMSUseKey
  (alias-conditioned) for runtime use — having it in both is harmless.

## Least-Privilege Refactors (EC2 Networking)

The entries above are permissions *added* to fix deployment failures. The
entry below is a *tightening* — replacing an unconditional `Resource: "*"`
statement with tag-scoped conditions — motivated by the user's
least-privilege preference (see USER PROFILE). NOTE: the Create-side tag
condition was later REMOVED (see "EC2NetworkingCreate: tag condition REMOVED"
below) because CloudFormation doesn't send tags inline for all EC2 creates.
Only the Manage/Delete side (`aws:ResourceTag/Name`) keeps its condition.
A future session that "cleans up" the policy by removing the Manage-side
conditions must NOT do so: those conditions are the blast-radius guard for
destructive operations. Same purpose as the rest of this file — documented
here so future sessions don't remove them.

### EC2Networking → Describe / Create / Manage split
- **Before**: one `EC2Networking` statement, all actions on `Resource: "*"`
  with no conditions. `ec2:DeleteVpc` could delete ANY VPC in the account.
- **After**: three statements in `bclaw-deploy-policy.json`:
  1. `EC2Describe` — the 8 `ec2:Describe*` actions, `Resource: "*"`, no
     condition. AWS does not support resource ARNs on EC2 Describe calls
     (they return account-wide lists), so `*` is the only option and is safe
     (read-only).
  2. `EC2NetworkingCreate` — `CreateVpc`, `CreateInternetGateway`,
     `CreateSubnet`, `CreateRouteTable`, `CreateSecurityGroup`,
     **`CreateTags`** — `Resource: "*"`, **unconditional**. (Originally gated
     on `aws:RequestTag/Name: bclaw*`, but the condition was removed — see
     "EC2NetworkingCreate: tag condition REMOVED" below. Create operations
     are safe: in-account, deletable, minimal blast radius.)
  3. `EC2NetworkingManage` — `DeleteVpc`, `ModifyVpcAttribute`, IGW
     attach/detach/delete, subnet delete/modify, route-table
     delete/assoc/disassoc, create/delete route, SG delete/ingress/egress,
     `DeleteTags` — `Resource: "*"`, condition
     `aws:ResourceTag/Name: bclaw*`. The target resource must already wear
     the tag.

**WHY `ec2:CreateTags` is in the Create statement, NOT the Manage
(ResourceTag) statement.** This is a non-obvious chicken-and-egg trap that
bit a real deploy. CloudFormation adds tags to an existing resource by
calling `ec2:CreateTags` (the EC2 API to *add* a tag is called `CreateTags`,
regardless of whether the resource already exists). If `CreateTags` sits in
a statement gated by `aws:ResourceTag/Name: bclaw*`, the condition checks the
resource's *existing* tags — but a resource that has never been tagged has NO
Name tag, so the condition fails and the `CreateTags` call is denied. You can
never bootstrap a tag onto an untagged resource through a ResourceTag-gated
statement. That's why `CreateTags` stays in the (now unconditional) Create
statement, not the Manage statement. `DeleteTags` stays in the Manage
statement (ResourceTag-gated) because by the time you're deleting a tag, the
resource already exists and its tags can be read. This same asymmetry is why
`EFSFileSystemCreate` uses `RequestTag` and `EFSFileSystemManage` uses
`ResourceTag` — the pattern is general: tag-adding actions go with the
Create-side statement (RequestTag-gated or unconditional), tag-on-existing-
resource actions go with ResourceTag.

**WHY Create and Manage are SEPARATE statements, not one.** `RequestTag`
evaluates tags *in the API request* (present on creates, absent on
deletes/attaches). `ResourceTag` evaluates tags *on the existing target*
(meaningful for manage/delete; the resource doesn't exist yet at create
time). IAM conditions combine with AND within a statement. Put both in one
statement and a Create fails the `ResourceTag` check (no existing resource
to read tags from) while a Delete fails the `RequestTag` check (no tags in a
delete request). They MUST live in separate statements. This mirrors the
existing `EFSFileSystemCreate` (RequestTag) / `EFSFileSystemManage`
(ResourceTag) pair already in the policy.

**WHY the prefix is `bclaw*` not `bclaw`.** The claw tags resources with
role-suffixed names (`bclaw-vpc`, `bclaw-igw`, `bclaw-subnet-a`,
`bclaw-rt-public`, `bclaw-sg`). `StringLike` with `bclaw*` matches all of
them; an exact `bclaw` would match none.

### EC2NetworkingCreate: tag condition REMOVED (June 2026)
- **Error**: `AccessDenied` on `ec2:CreateSubnet`, `ec2:CreateRouteTable`,
  and `ec2:CreateSecurityGroup` during stack creation — all three failed
  with identical "no identity-based policy allows this action" errors,
  despite all three being in the `EC2NetworkingCreate` statement.
- **Why**: The `aws:RequestTag/Name: bclaw*` condition requires the Name
  tag to be present *in the Create API request itself*. CloudFormation's
  EC2 resource handler sends tags inline for `CreateVpc` (which passed),
  but does NOT send them inline for `CreateSubnet`, `CreateRouteTable`, or
  `CreateSecurityGroup`. Instead, it creates the resource first, then
  applies tags via a separate `CreateTags` call. So at Create time the tag
  is absent from the request, the `RequestTag` condition fails, and the
  entire Create is denied.
- **Confirmed via simulation**: `simulate-principal-policy` with
  `aws:RequestTag/Name=bclaw-subnet-a` context returned `allowed`; without
  it returned `implicitDeny`. The real CFN call was equivalent to the
  no-context case.
- **Fix**: Removed the `Condition` from `EC2NetworkingCreate` entirely.
  Create actions are now unconditional `Resource: "*"`. Rationale: Create
  operations only add resources to the caller's own account (deletable,
  minimal blast radius), so the tag condition is unnecessary complexity
  that causes unpredictable failures depending on which CFN resource
  handler sends tags inline.
- **What stays conditioned**: `EC2NetworkingManage` (delete/modify) keeps
  `aws:ResourceTag/Name: bclaw*`. Deletes are dangerous (could destroy
  production infrastructure), so they remain tag-scoped. By the time a
  resource is being managed/deleted, it already exists and carries tags,
  so the ResourceTag condition evaluates correctly. The EFS
  `CreateFileSystem`/`Manage` split also keeps its conditions (EFS sends
  tags inline on create).
- **Generalization**: `aws:RequestTag` conditions on EC2 Create actions
  are fragile — whether the tag appears in the request depends on the
  CloudFormation resource handler implementation, not the template. Do
  not use `RequestTag` conditions on EC2 creates unless you've confirmed
  the specific resource handler sends tags inline.

**Multi-resource operations evaluate BOTH resources.** `AttachInternetGateway`
and `AssociateRouteTable` reference two ARNs (IGW+VPC, RT+subnet). The
`aws:ResourceTag/Name` condition must hold for BOTH. In this template both
peers carry `bclaw*` Name tags, so it passes — but if a future template
change attaches to an *un*-tagged resource (e.g. the default VPC), the call
will be denied. That is the intended blast-radius limit.

**Tagging is NOT always part of the Create call.** CloudFormation sets `Tags`
in the resource's `Properties`, but whether the underlying EC2 Create* API
actually carries the tags inline depends on the resource handler. `CreateVpc`
sends tags inline (confirmed: CreateVpc with a `bclaw*` tag passed the
`aws:RequestTag/Name` condition in a real deploy). But `CreateSubnet`,
`CreateRouteTable`, and `CreateSecurityGroup` do NOT — the handler creates
the resource first, then applies tags via a separate `CreateTags` call. This
is why `aws:RequestTag/Name` conditions on EC2 Create actions are fragile
and were removed from `EC2NetworkingCreate`. See "EC2NetworkingCreate: tag
condition REMOVED" above for the full diagnosis.

## Template Fixes (template.yaml)

### AZ parameter defaults: !Select/!GetAZs → literal strings
- **Error**: `Every Default member must be a string`
- **Why**: CloudFormation does not allow intrinsic functions (like `!Select`
  or `!GetAZs`) in parameter `Default` values — they must be literal strings.
- **Fix**: Changed AZ1 default to `us-east-1a`, AZ2 to `us-east-1b`. The setup
  skill passes explicit AZ values via `--parameter-overrides` anyway.

### SecurityGroup self-referencing ingress → separate resource
- **Error**: `Circular dependency between resources: [EFSMountTargetA,
  EFSMountTargetB, Service, SecurityGroup, TaskDefinition]`
- **Why**: The SecurityGroup had an inline `SecurityGroupIngress` rule with
  `SourceSecurityGroupId: !Ref SecurityGroup` (self-reference for NFS port
  2049). CloudFormation cannot resolve a resource that references itself.
- **Fix**: Split into a separate `AWS::EC2::SecurityGroupIngress` resource
  (`SecurityGroupSelfIngress`) that references the SecurityGroup by ARN.

### EFS Tags → FileSystemTags
- **Error**: `Model validation failed (#: extraneous key [Tags] is not
  permitted)`
- **Why**: `AWS::EFS::FileSystem` uses `FileSystemTags`, not `Tags`. (Access
  point resources correctly use `AccessPointTags`.)
- **Fix**: Changed `Tags` to `FileSystemTags` on the EFSFileSystem resource.

### Conditional provider keys (EnableOpenRouterKey / EnableZaiKey / EnableAnthropicKey)
- **Problem**: Adding a provider API key (OPENROUTER_API_KEY, ANTHROPIC_API_KEY,
  ZAI_API_KEY) to the secrets list unconditionally would break deployments that
  don't use that provider — ECS requires every secret in the `secrets[]` list to
  resolve at task start time, and a missing SSM parameter causes a crash-loop.
- **Fix**: Each opt-in key gets its own `String` parameter (default `"false"`,
  `AllowedValues: ["true","false"]`) and a `Conditions` entry
  (`OpenRouterKeyEnabled`, `ZaiKeyEnabled`, `AnthropicKeyEnabled`). The secret
  is injected via `!If` — included only when the matching `Enable*Key=true`,
  otherwise `!Ref AWS::NoValue` (omitted entirely). The setup skill asks the
  user which single provider to use (OpenRouter recommended) and enables exactly
  one. Deploy with e.g. `--parameter-overrides EnableOpenRouterKey=true` when
  the corresponding `/bclaw/OPENROUTER_API_KEY` (or ANTHROPIC_API_KEY /
  ZAI_API_KEY) SSM parameter exists. The pattern is the same for any future
  opt-in provider key.

### SecurityGroup Name tag (required by the EC2 tag-conditioned IAM split)
- **Problem**: After the EC2Networking → Create/Manage split (above), every
  EC2 resource the stack creates must carry a `bclaw*` Name tag or the
  `aws:ResourceTag/Name` condition denies its management. The SecurityGroup
  set only `GroupName` (a property, not a tag), so it had no Name tag at all
  — meaning `DeleteSecurityGroup`, `AuthorizeSecurityGroupIngress`, and
  `RevokeSecurityGroupIngress` would all be denied.
- **Why**: `GroupName` is a resource property, not a tag. EC2 tag conditions
  key on the `Name` *tag* (the `aws:ResourceTag/Name` key), which is
  separate from any name-like property.
- **Fix**: Added `Tags: [{ Key: Name, Value: !Sub "${ClawName}-sg" }]` to the
  SecurityGroup resource. All EC2 resources the stack creates now carry a
  `bclaw*` Name tag: `bclaw-vpc`, `bclaw-igw`, `bclaw-subnet-a/b`,
  `bclaw-rt-public`, `bclaw-sg`.
- **Generalization**: whenever you add a tag-condition to the IAM policy,
  audit EVERY CloudFormation resource of that service for a matching tag.
  Properties that look like names (`GroupName`, `LogGroupName`) are NOT tags
  and will not satisfy `aws:ResourceTag/Name`.

## Operational Notes

### DesiredCount resets to 0 on stack updates
The template hardcodes `DesiredCount: 0` (safety design — prevents the task
from crash-looping before SSM secrets exist on initial deploy). On stack
*updates* (e.g., adding a new secret, changing the image tag), CloudFormation
reverts DesiredCount back to 0, stopping the running task.

**Workaround**: After any stack update, re-scale:
```bash
aws ecs update-service --cluster bclaw --service bclaw --desired-count 1 --region "$AWS_REGION"
```

**Future improvement**: Make DesiredCount a parameter (default 0 for initial
safety, override to 1 on updates).

### Recovering from UPDATE_ROLLBACK_FAILED

A stack update can fail and enter `UPDATE_ROLLBACK_FAILED` — a terminal state
where the automatic rollback itself failed (e.g. because the deployer policy
lacks a permission needed to revert a resource). The stack is stuck and blocks
all updates until recovered. The recovery sequence:

1. Read `describe-stack-events` to find the resource(s) that failed during
   rollback (filter for `UPDATE_ROLLBACK_FAILED` / `UPDATE_FAILED` statuses).
2. Run `continue-update-rollback --resources-to-skip <LogicalId>` for any
   resource that's already in its target/original state. CFN marks it as
   successfully rolled-back without re-attempting the failing operation.
   Requires `cloudformation:ContinueUpdateRollback` in the deployer policy
   (see the IAM gap entry above — it's a common omission).
3. The stack returns to `UPDATE_ROLLBACK_COMPLETE` — a usable state.
4. Fix the root cause (e.g. add the missing IAM permission), re-attach the
   policy if it's a console-managed attachment, then `update-stack` again.

**Waiter gotcha**: `aws cloudformation wait stack-update-complete` treats
`UPDATE_ROLLBACK_COMPLETE` as a *failure* (it only waits for
`UPDATE_COMPLETE`). After step 2, check `describe-stacks --query
Stacks[0].StackStatus` directly rather than relying on the waiter.

**Safety**: `--resources-to-skip` tells CFN "this resource is fine, stop
trying to change it" — it does NOT delete or modify the resource. When the
resource genuinely is in its original state (the update never took effect),
skipping is a no-op. Only skip resources you've verified are in a safe state.

### Pre-flight simulation limitations
`simulate-principal-policy` with default `*` resource doesn't catch permission
gaps for pinned-resource statements — the simulation evaluates against `*`,
which doesn't match the policy's pinned ARNs (e.g. `stack/bclaw/*`,
`log-group:/ecs/bclaw*`). To get accurate results, pass `--resource-arns` with
the actual ARNs. In practice, the canonical policy has been battle-tested and
includes all needed permissions; the simulation is a sanity check, not a
guarantee.

### Debugging tag-conditioned IAM failures
When you see `AccessDenied` on an action that IS listed in the policy, the
cause is often a tag condition (`aws:RequestTag` or `aws:ResourceTag`) that
isn't being satisfied at runtime. Use `simulate-principal-policy` in two steps
to diagnose:

1. **Run WITHOUT context entries.** If the action returns `implicitDeny`,
   check `MissingContextValues` in the output — if `aws:RequestTag/Name` or
   `aws:ResourceTag/Name` appears there, a tag condition is the blocker.
   ```bash
   aws iam simulate-principal-policy \
     --policy-source-arn "$CALLER_ARN" \
     --action-names ec2:CreateSubnet \
     --resource-arns "$VPC_ARN" \
     --query 'EvaluationResults[0].{Decision:EvalDecision, Missing:MissingContextValues}' \
     --output json
   ```

2. **Run WITH the matching context entry.** If it returns `allowed`, the
   condition is syntactically correct — meaning the real API call isn't
   carrying the tag. This is the signature of a CloudFormation handler that
   doesn't send tags inline.
   ```bash
   aws iam simulate-principal-policy \
     --policy-source-arn "$CALLER_ARN" \
     --action-names ec2:CreateSubnet \
     --resource-arns "$VPC_ARN" \
     --context-entries ContextKeyName=aws:RequestTag/Name,ContextKeyValues=bclaw-subnet-a,ContextKeyType=string \
     --query 'EvaluationResults[0].EvalDecision' --output text
   ```

**Interpretation:** Step 2 returning `allowed` while the real CFN call fails
proves the handler isn't sending the tag. For `RequestTag` conditions on
Create actions, the fix is to remove the condition (creates are safe —
in-account, deletable). For `ResourceTag` conditions on Manage/Delete actions,
the issue is different: it means the resource doesn't carry the expected tag
(a template/policy mismatch), not a handler limitation — fix the template to
tag the resource.

## Namespace Migrations (SSM `/harness/` → `/bclaw/`)

The SSM parameter namespace was migrated from `/harness/` to `/bclaw/` to
align with the claw-specific naming convention. The namespace is still
**hardcoded** in the template and IAM policy (not constructed from `ClawName`),
preserving the deterministic IAM scope. Two pitfalls surfaced:

### Pitfall 1: bare references without trailing slashes
A regex like `(?<!home)(?<!etc)/harness/` (with trailing slash) catches most
references but misses bare occurrences: the CFN output `Value: "/harness"` and
prose like "should be `/harness`". After any namespace migration, do a second
pass for the token without a trailing slash.

### Pitfall 2: design narrative becomes self-contradictory
After replacing `/harness/` with `/bclaw/`, prose that said the namespace was
"static, NOT the claw name" became false — `/bclaw/` IS the claw name. The
correct framing is "hardcoded in the template, not derived from the `ClawName`
parameter" (the namespace matches the default claw name but is not computed
from it at deploy time). Audit all explanatory comments after a rename.

### Preserved contexts
`/harness/` appears in three non-SSM contexts that must NOT be changed:
- `/home/harness/` — the container's Linux home directory (EFS-backed)
- `/etc/harness/` — container filesystem paths (e.g. `setup-env.sh`)
- `boldblackai/harness/` — GitHub repository URL
