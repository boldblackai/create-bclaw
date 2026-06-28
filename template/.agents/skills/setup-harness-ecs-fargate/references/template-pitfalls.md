# CloudFormation Template Pitfalls

Issues discovered during real deployments of `template.yaml`. All are already
fixed in the current template, but documenting them prevents regression when
modifying the template and helps debug similar issues.

## 1. EFS FileSystem: use `FileSystemTags`, not `Tags`

`AWS::EFS::FileSystem` rejected the top-level `Tags` property with:

```
Model validation failed (#: extraneous key [Tags] is not permitted)
```

**Fix:** Use `FileSystemTags` instead. The access points correctly use
`AccessPointTags` (a different property name on `AWS::EFS::AccessPoint`).

## 2. SecurityGroup self-referencing ingress: extract to separate resource

Defining a self-referencing ingress rule inline in `AWS::EC2::SecurityGroup`
causes a circular dependency:

```
Circular dependency between resources: [EFSMountTargetA, EFSMountTargetB,
Service, SecurityGroup, TaskDefinition]
```

This happens because `SourceSecurityGroupId: !Ref SecurityGroup` inside the
SG's own `SecurityGroupIngress` creates a self-reference that CloudFormation
cannot resolve. Mount targets and the ECS service all depend on the SG, and
the SG depends on itself.

**Fix:** Extract the ingress rule into a separate
`AWS::EC2::SecurityGroupIngress` resource:

```yaml
SecurityGroup:
  Type: AWS::EC2::SecurityGroup
  Properties:
    GroupName: !Ref ClawName
    GroupDescription: !Sub "ECS + EFS for ${ClawName}"
    VpcId: !Ref VPC
    # NO inline SecurityGroupIngress here

SecurityGroupSelfIngress:
  Type: AWS::EC2::SecurityGroupIngress
  Properties:
    GroupId: !Ref SecurityGroup
    IpProtocol: tcp
    FromPort: 2049
    ToPort: 2049
    SourceSecurityGroupId: !Ref SecurityGroup
```

## 3. Parameter defaults cannot use intrinsic functions

CloudFormation rejects intrinsic functions in parameter `Default` values:

```
Template format error: Every Default member must be a string.
```

The original template used `Default: !Select [0, !GetAZs ""]` for `AZ1`/`AZ2`
parameters. CloudFormation validates all parameter defaults as literal strings
during change-set creation, even when the values are overridden via
`--parameter-overrides`.

**Fix:** Use literal string defaults (e.g. `Default: us-east-1a`). The setup
skill always passes explicit AZ values via `--parameter-overrides`, so the
defaults are only fallbacks.

## 4. KMS key creation: alias-conditioned permissions fail before alias exists

The deployer IAM policy scopes `kms:Decrypt`/`kms:Encrypt` etc. to the claw's
CMK via `kms:ResourceAliases = alias/bclaw-ssm`. But during stack creation, the
KMS key is created BEFORE the alias resource (`SsmKmsAlias`) — so any
permission that needs to operate on the key during creation (before the alias
exists) will fail the alias condition.

**Affected actions (must be in the unconstrained `KMSCreateKey` statement):**
- `kms:PutKeyPolicy` — CloudFormation validates the caller can update the key
  policy in the future
- `kms:EnableKeyRotation` — set via `EnableKeyRotation: true` on the key
  resource
- `kms:DescribeKey` — needed by `!GetAtt SsmKmsKey.Arn` when other resources
  (e.g. ExecutionRole) reference the key ARN

**Fix:** Keep these in `KMSCreateKey` (Resource: `*`, no condition), NOT in
`KMSUseKey` (alias-conditioned). If they land in `KMSUseKey`, the alias
condition will fail at deploy time because the KMS alias doesn't exist yet
during key creation.

## 5. CloudFormation stack ARN includes a UUID suffix

The stack ARN is `arn:aws:cloudformation:*:*:stack/bclaw/<uuid>`, not
`arn:aws:cloudformation:*:*:stack/bclaw`. Pinning to `stack/bclaw` (without
the `/*` wildcard) causes `AccessDenied` on `DescribeStacks` even though the
action is in the policy.

**Fix:** Use `arn:aws:cloudformation:*:*:stack/bclaw/*` in the policy.

## 6. Missing permissions discovered during real deploys

These actions were missing from the original `bclaw-deploy` policy and caused
deploy failures. All are now included:

| Action | Why it's needed | Statement |
|---|---|---|
| `cloudformation:DescribeChangeSet` | `aws cloudformation deploy` calls it to poll change-set status | CloudFormation |
| `cloudformation:GetTemplateSummary` | `aws cloudformation deploy` calls it to analyze the template before creating a change set | CloudFormation |
| `ec2:DescribeInstanceTypeOfferings` | ARM64 AZ probe in Phase 1a | EC2Networking |
| `ec2:ModifySubnetAttribute` | Template sets auto-assign public IP on subnets | EC2Networking |
| `logs:PutRetentionPolicy` | `RetentionInDays` on the log group | LogsScoped |
| `logs:FilterLogEvents` | `aws logs tail` (reading logs post-deploy) | LogsScoped |
| `logs:GetLogEvents` | `aws logs get-log-events` (reading logs post-deploy) | LogsScoped |
| `kms:PutKeyPolicy` | KMS key creation validation | KMSCreateKey |
| `kms:EnableKeyRotation` | `EnableKeyRotation: true` on key resource | KMSCreateKey |
| `kms:DescribeKey` | `!GetAtt SsmKmsKey.Arn` during ExecutionRole creation | KMSCreateKey |

## 7. Stack updates reset DesiredCount to 0

The template hardcodes `DesiredCount: 0` on the ECS service — this is
intentional for initial deploy (prevents crash-looping before SSM secrets
exist, see Phase 3/4). But on a **stack update** (e.g. adding a new secret to
the task definition), CloudFormation reverts the running count to 0, stopping
the live task.

**Workaround:** After any stack update, re-scale to 1:
```bash
aws ecs update-service --cluster "$CLAW_NAME" --service "$CLAW_NAME" \
  --desired-count 1 --region "$AWS_REGION"
```
Then wait for RUNNING (`aws ecs wait tasks-running ...`).

**Future fix:** Make `DesiredCount` a CloudFormation parameter (default 0,
override to 1 on updates via `--parameter-overrides DesiredCount=1`).

## 8. Debugging: use `create-change-set` when `deploy` gives cryptic errors

`aws cloudformation deploy` sometimes fails with unhelpful errors like:

```
aws: [ERROR]: 'Status'
```

This happens when `deploy` can't parse the response from a sub-call. To get
the actual error, run the change-set creation manually:

```bash
aws cloudformation create-change-set \
  --stack-name "$CLAW_NAME" \
  --template-body file://path/to/template.yaml \
  --change-set-name debug \
  --change-set-type CREATE \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters ParameterKey=ClawName,ParameterValue=bclaw \
  --region "$AWS_REGION"
```

Then describe the change set to see the real validation error:
```bash
aws cloudformation describe-change-set \
  --stack-name "$CLAW_NAME" --change-set-name debug \
  --region "$AWS_REGION"
```

For `CREATE_FAILED` events on an existing stack, use:
```bash
aws cloudformation describe-stack-events --stack-name "$CLAW_NAME" \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`].{LogicalId:LogicalResourceId, Reason:ResourceStatusReason}' \
  --output table
```

The `StatusReason` field names the exact missing permission or validation error.

## 9. InitProcessEnabled vs the image's baked-in tini ENTRYPOINT

The harness image's ENTRYPOINT is `["/tini", "--", "/entrypoint.sh"]` (verified
via `/proc/1` in a running container: `/tini -- /entrypoint.sh hermes chat`).
tini is already PID 1 (signal forwarding + zombie reaping).

Earlier versions of the template also set
`LinuxParameters: { InitProcessEnabled: true }` on the container. This stacks
ECS's init-process layer on top of tini — redundant, since both act as
PID-1-style reapers, and tini is the better signal forwarder for
`hermes gateway`.

**Fix:** `InitProcessEnabled` is removed from the template. The task definition
sets neither `EntryPoint` (the image's baked-in one runs) nor
`InitProcessEnabled` — tini from the image ENTRYPOINT is the sole init.

**Key ECS semantics** (why overriding `Command` is safe and does NOT bypass
tini/entrypoint): ECS `Command` overrides only the image's CMD, NOT its
ENTRYPOINT. So on every boot the full chain runs:
`/tini` (PID 1, from ENTRYPOINT) → `/entrypoint.sh` (sources setup-env.sh,
seeds config.yaml) → `exec "$@"` where `"$@"` is the task `Command`. Setting
an explicit `EntryPoint` in the task def would override the image's — don't,
unless you intend to replace the tini+entrypoint chain.

See `references/on-boot-commands.md` for the full boot-chain diagram and the
on-boot `Command`-wrapper pattern.

## 10. `cloudformation deploy` reverts un-passed parameters to template defaults

`aws cloudformation deploy` uses the **template's parameter `Default`** for any
parameter NOT listed in `--parameter-overrides` — it does NOT remember the
prior stack's parameter values. This is a silent regression: the stack updates
"successfully" but with parameters reverted, and the only symptom is the
downstream misconfiguration.

**Near-miss from a real deploy:** the stack was created with
`EnableZaiKey=true` (ZAI_API_KEY is the gateway's model provider). A later
`cloudformation deploy` that omitted `EnableZaiKey` from `--parameter-overrides`
would have reverted it to the template default `false`, silently dropping
`ZAI_API_KEY` from the task definition. The bot would come up unable to reach
its model — a non-obvious, hard-to-diagnose failure. (Caught by reading the
live stack params with `describe-stacks` before deploying.)

**Fix:** Before any stack update, capture the current parameter values and
re-pass ALL of them:

```bash
# Capture current params (do this FIRST, before the deploy)
aws cloudformation describe-stacks --stack-name "$CLAW_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Parameters[].{Key:ParameterKey,Value:ParameterValue}' --output table

# Then deploy, re-passing every non-default param — especially the enabled
# provider key among EnableOpenRouterKey / EnableZaiKey / EnableAnthropicKey,
# plus EnableGitHubKey (all template default false) and any AZ/image/cpu
# overrides you set earlier
aws cloudformation deploy ... \
  --parameter-overrides \
    ClawName="$CLAW_NAME" HarnessImageTag=<tag> \
    CpuArchitecture=<arch> TaskCpu=<cpu> TaskMemory=<mem> \
    TimeZone=<tz> AZ1=<az1> AZ2=<az2> \
    EnableOpenRouterKey=<true|false> EnableZaiKey=<true|false> EnableAnthropicKey=<true|false> \
    EnableGitHubKey=<true|false>
```

**Verify after every stack update that the live task def matches intent** —
don't reason from the template on disk. Query the running state:

```bash
aws ecs describe-task-definition --task-definition "$CLAW_NAME" --region "$AWS_REGION" \
  --query 'taskDefinition.{Command:containerDefinitions[0].command, Secrets:containerDefinitions[0].secrets[].name, Env:containerDefinitions[0].environment[].name}' \
  --output json
```

Compare the output against what you intended to deploy. A reverted provider
`Enable*Key` shows up here as the missing matching secret in `Secrets` —
e.g. `EnableOpenRouterKey` → missing `OPENROUTER_API_KEY`,
`EnableZaiKey` → missing `ZAI_API_KEY`, `EnableAnthropicKey` → missing
`ANTHROPIC_API_KEY`, `EnableGitHubKey` → missing `GH_TOKEN_VAL`. (General
principle: when
asked "is X deployed / applied?", query the live AWS resource
(`describe-task-definition`, `describe-stack`, `describe-services`), never infer
from the template file on disk — the two can diverge.)

## 11. PyYAML lint false-positive on CloudFormation intrinsic shorthand

When editing `template.yaml` with the `patch` or `write_file` tools, the built-in
linter (PyYAML) reports errors like:

```
could not determine a constructor for the tag '!Equals'
  in "<unicode string>", line N, column M
```

**These are false positives.** CloudFormation's intrinsic-function shorthand
(`!Ref`, `!Sub`, `!If`, `!Equals`, `!GetAtt`, `!GetAZs`, `!Join`, etc.) is valid
CFN but not valid YAML — PyYAML doesn't know how to resolve `!`-prefixed tags.
Every edit to the template triggers this noise, and it masks real errors.

**How to distinguish false positives from real errors:**
- If the lint message says `could not determine a constructor for the tag '!Xxx'`
  where `Xxx` is a known CFN intrinsic (`Equals`, `Sub`, `If`, `Ref`, `GetAtt`,
  `GetAZs`, `Join`, `Select`, `Split`, `Base64`, `FindInMap`, `ImportValue`,
  `And`, `Or`, `Not`, `Condition`, `Cidr`) → **false positive, ignore it.**
- If the lint message says something else (e.g. `mapping values are not allowed`,
  `found character that cannot start any token`, `expected <block end>`) → **real
  error, investigate.**

**Validate the template properly** after edits using the CFN-tag-aware validator:

```bash
python3 scripts/validate-template.py
```

This parses `template.yaml` with a custom YAML loader that resolves all `!` tags
into inspectable `{Tag: value}` dicts, then checks structure: required top-level
keys, that every `!If` references a condition that exists in `Conditions`, that
every `!Ref` in `Conditions` points to a real `Parameter`, and prints a summary
of all parameters, conditions, and task-definition secrets. Exits non-zero on
real problems. Run it after any template edit to confirm the structure is sound
before committing or deploying.
