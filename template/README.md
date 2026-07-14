# bclaw

A Hermes Agent claw — a long-running gateway deployed as a Slack socket-mode
bot. It is outbound-only: no load balancer, no inbound ports. The Slack app
manifest lives in `slack-manifest.json`.

Runs on AWS ECS using the **EC2 launch type** — a single container instance in
an Auto Scaling Group (`min=max=desired=1`) with a **persistent EBS data
volume** for the claw's SQLite databases. Deployed and torn down via the agent
skills in `.agents/skills/`.


## Tooling

`mise` manages all tools (`aws-cli`, `direnv`, `jj`) — see `mise.toml`. Do not
install system-wide. Activate mise in every shell:

```bash
eval "$(/usr/local/bin/mise activate bash)" && mise trust
```


## Setup

The setup skill can't run until AWS credentials exist, and credentials need a
principal allowed to create + tear down the claw. Set up a dedicated
least-privilege deployer user rather than reusing a broad admin principal, then
run the skill.

### 1. Create the deployer IAM user

IAM → Users → Create user (e.g. `bclaw-deployer`) with programmatic access (an
access key).

### 2. Attach the `bclaw-deploy` policy

Attach the policy in [`bclaw-deploy-policy.json`](./bclaw-deploy-policy.json)
to the user. It grants exactly the claw create + teardown permissions, no more.

Resources are tightened to the claw's name-prefixed ARNs wherever AWS lets us.
Several statements still carry `Resource: "*"` — these are **not** laziness but
hard AWS constraints. The action list stays narrow in every case.

#### Why some resources stay `Resource: "*"`

The pinning rule: **a resource can be pinned to a prefix only if its ARN is
name-based** (CloudFormation stacks, IAM roles, ECS clusters/services, log
groups all use names the template controls). Resources whose ARNs use
**AWS-assigned IDs** cannot be pinned by ARN prefix — but if they support tags,
they're constrained with `aws:ResourceTag` conditions instead (the ABAC
pattern). The statements below carry `Resource: "*"` with **no condition** —
the hard AWS constraints:

| Statement | Why it stays `*` (no condition) |
|---|---|
| `ReadOnlyDescribe` | Merged read-only bucket: every `Describe*`/`List*` action across EC2/ASG/Logs/SSM/ECS is List-type with no resource-level support (AWS requires `*`). Also carries `ec2:DescribeImages` (the launch-template handler validates the AMI at create time) and `ecs:ListContainerInstances`. All read-only; the sensitive create/delete/mutate actions are separately scoped. |
| `EC2NetworkingCreate` | Creating VPC/subnet/IGW/route-table/SG + `CreateTags` is safe — the resources don't exist yet to pin to. The sensitive networking **deletes** ARE tag-conditioned (`EC2NetworkingManage`, below). |
| `EC2LaunchTemplateManage` | `AWS::EC2::LaunchTemplate` has no top-level `Tags` property (CFN can't tag it reliably), so launch-template CRUD can't be tag-scoped. Also carries `ec2:CreateTags`. Launch templates are account-scoped and low-risk; the deployer does not call `ec2:RunInstances` (the Auto Scaling Group's service-linked role launches instances), so instance-launch perms are deliberately absent from this policy. |
| `ECSTaskDefsAndTasks` | **Task definitions do not support resource-level permissions** — `RegisterTaskDefinition`/`DescribeTaskDefinition`/`DeregisterTaskDefinition` must be `*`. `DescribeTasks`/`ListTasks` operate on tasks with runtime-assigned IDs. (Clusters and services DO support RLP and are pinned in `ECSScoped`.) |
| `SSMMessages` | Amazon Message Gateway Service (`ssmmessages`) does not support resource-level permissions at all — AWS requires `Resource: "*"` for all four channel actions. Needed for `aws ecs execute-command` (ECS Exec) over the host's internet path. The sensitive `ecs:ExecuteCommand` itself IS scoped to bclaw tasks/cluster (`ECSExec`). |
| `KMSCreateKey` | `kms:CreateKey` creates a not-yet-existing key — no ARN to pin. `kms:CreateAlias`/`kms:DeleteAlias`/`kms:PutKeyPolicy`/`kms:EnableKeyRotation`/`kms:DescribeKey` run **before the alias exists**, so they CANNOT be alias-conditioned. Also carries `sts:DecodeAuthorizationMessage` (diagnosing AccessDenied errors — no relevant resource). The sensitive `kms:Decrypt`/`kms:Encrypt` ARE alias-conditioned (`KMSUseKey`). |
| `SSMPublicEcsAmi` | Read-only AWS-published public AMI-id parameters (`/aws/service/ecs/optimized-ami/...`). The `EcsAmiId` stack parameter is type `AWS::SSM::Parameter::Value<Image::Id>`, so CloudFormation reads these at change-set time. Public AMI-id values, not secrets. |

**Tag-conditioned statements** (ABAC — a tag condition restricts to our
resources; all use `Resource: "*"` except `EC2InstanceOps`, which is
additionally ARN-scoped to `instance/*`):

| Statement | Condition | What it protects |
|---|---|---|
| `EC2NetworkingManage` | `aws:ResourceTag/Name = bclaw*` | Can only delete/mutate the claw's own VPC/subnets/route-tables/IGW/SG. Cannot touch any other networking in the account. |
| `EC2InstanceOps` | `aws:ResourceTag/ClawName = bclaw` (ARN-scoped to `instance/*`) | Can only read the console output of, or terminate, the claw's own container instances. Cannot touch co-tenant instances in the account. (`GetConsoleOutput` for boot/UserData debugging; `TerminateInstances` for manual force-replace — the ASG launches a successor that reattaches the EBS volume.) |
| `EC2DataVolumeCreate` | `aws:RequestTag/Name = bclaw-data` | Can only create an EBS volume tagged `Name=bclaw-data`. Prevents creating arbitrary volumes. |
| `EC2DataVolumeManage` | `aws:ResourceTag/Name = bclaw-data` | Can only delete/detach the claw's own data volume. |
| `AutoScalingCreate` | `aws:RequestTag/ClawName = bclaw` | Can only create an Auto Scaling Group tagged with the claw's shared `ClawName` tag. |
| `AutoScalingManage` | `aws:ResourceTag/ClawName = bclaw` | Can only delete/update the claw's own ASG. |
| `KMSUseKey` | `kms:ResourceAliases = alias/bclaw-ssm` | Can only Decrypt/Encrypt/ScheduleKeyDeletion on the claw's own CMK. Cannot use any other KMS key in the account. |

ARN-pinned statements (no `*`): `CloudFormation` (`stack/bclaw/*`), `IAMRoles`
(`role/bclaw-*`), `IAMInstanceProfiles` (`instance-profile/bclaw-*`), `PassRole`
(`role/bclaw-*` + `instance-profile/bclaw-*`), `ECSScoped` (`cluster/bclaw`,
`service/bclaw/*`), `ECSExec` (`cluster/bclaw`, `task/bclaw/*`), `LogsScoped`
(`log-group:/ecs/bclaw*`), `SSMSecrets` (`parameter/bclaw/*`),
`CreateAutoScalingServiceLinkedRole` (the ASG SLR role path), and
`DenyDirectSSMSession` (`task/bclaw/*`, a Deny).

> **`PassRole` has no `iam:PassedToService` condition** — only the `Resource`
pin to `bclaw-*` roles + instance-profiles. The condition was dropped because
the Auto Scaling service's launch-template validation checks PassRole with a
`PassedToService` value the single-value condition didn't match (it broke ASG
creation). The `Resource` scope is the boundary: the deployer can only pass the
claw's own roles.

#### Notes

- **Shell-in (ECS Exec) permissions are included.** The policy grants
  `ecs:ExecuteCommand` scoped to the bclaw cluster + tasks (`ECSExec`), plus the
  four `ssmmessages:*` channel actions (`SSMMessages`). These are needed by the
  setup skill (Phases 5–6), teardown skill, and the `manage-bclaw`
  skill. With host networking the SSM agent reaches `ssmmessages` over the
  container instance's public IP — no NAT gateway, no VPC endpoints.
  `ssmmessages:*` cannot be resource-scoped — see the "Why some resources
  stay `Resource: *`" table below.

  AWS additionally recommends **denying** `ssm:StartSession` on ECS tasks
  (`DenyDirectSSMSession`). Sessions started via `ecs:ExecuteCommand` are logged;
  sessions started via `ssm:StartSession` bypass ECS Exec logging and consume the
  session quota. The deny blocks only direct SSM sessions on bclaw tasks — it
  does not affect `ecs:ExecuteCommand` (different API path).
- **No `simulate-principal-policy` pre-flight.** The policy deliberately omits
  `iam:SimulatePrincipalPolicy` (it was dropped to stay under the 6144-char
  managed-policy limit). Permission gaps surface as the exact `is not
  authorized to perform` error at deploy time instead; the policy's
  `sts:DecodeAuthorizationMessage` (in `KMSCreateKey`) lets you decode any
  encoded denial message for precise diagnosis.

### 3. Put the access key in `.env`

Create `.env` (gitignored) with the access key from step 1:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
```

`.envrc` sources `.env` via direnv. Activate direnv in every shell that runs
`aws`:

```bash
eval "$(/usr/local/bin/mise activate bash)" \
  && eval "$(direnv hook bash)" \
  && cd /workspace \
  && eval "$(direnv export bash)"
```

Verify:

```bash
aws sts get-caller-identity --query 'Account' --output text
```


## Slack app

The claw runs as a Slack **socket-mode** bot — it makes an outbound WebSocket
connection to Slack, so there is no inbound URL to host (the
`hermes-agent.local` request URLs in `slack-manifest.json` are placeholders,
ignored under socket mode). The manifest fully defines the app: name (`bclaw`),
the slash commands, OAuth scopes, event subscriptions, bot user, and
interactivity. Socket mode is on by default in the manifest.

### Create the app

1. Go to https://api.slack.com/apps → **Create New App** → **From an app
   manifest**.
2. Pick the workspace.
3. Paste the contents of [`slack-manifest.json`](./slack-manifest.json) →
   **Create**.

The app comes up with socket mode on, every slash command registered, the bot
user `bclaw`, OAuth scopes, and event subscriptions already configured —
nothing to toggle by hand.

### App-level token (socket mode auth)

Socket mode authenticates the outbound WebSocket with an app-level token, which
Slack generates separately (it can't live in the manifest):

- **Basic Information** → **App-Level Tokens** → **Generate Token and Scope**.
- Name it (e.g. `socket`), add the **`connections:write`** scope → **Generate**.
- Copy the `xapp-` token → this becomes `/bclaw/SLACK_APP_TOKEN`.

### Install to the workspace

- **OAuth & Permissions** → **Install to Workspace** → authorize.
- Copy the **Bot User OAuth Token** (`xoxb-`) → this becomes
  `/bclaw/SLACK_BOT_TOKEN`.

### Channel + user IDs

- **Your user ID** (for `/bclaw/SLACK_ALLOWED_USERS`): in Slack, click your
  profile → **Copy member ID**. Comma-separate multiple IDs.
- **Home channel ID** (for `/bclaw/SLACK_HOME_CHANNEL`): right-click the
  channel → **Copy link**, take the trailing ID.
- If the home channel is **private**, invite the bot with `/invite @bclaw` so
  it can read and post there (public channels are covered by its `channels:*`
  scopes once installed).

## Secrets you'll need

The claw needs SSM SecureString parameters under the `/bclaw/` namespace. The
scaffolder renames `bclaw` to your claw name everywhere — SSM paths, the IAM
scope, and the CloudFormation template — so the namespace matches the claw
name. It is a literal in the template (not derived from the `ClawName` parameter
at deploy time), which is what lets the IAM policy pin it to a fixed ARN prefix.
You'll enter them in the AWS console during the setup skill (Phase 3) — they're
not CloudFormation resources, so they survive stack updates and deletes. Four
are always required; a GitHub token is optional (enable it only if the agent
should make authenticated `gh`/HTTPS-git calls); plus exactly one
inference-provider key (you'll choose which in Phase 1 of the setup skill).
Gather the values beforehand:

### Always required

| SSM key | What it is | Where to find it |
|---|---|---|
| `/bclaw/SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-`) | Slack app → OAuth & Permissions → Bot User OAuth Token |
| `/bclaw/SLACK_APP_TOKEN` | Slack app-level token (`xapp-`, enables socket mode) | Slack app → Basic Information → App-Level Tokens |
| `/bclaw/SLACK_ALLOWED_USERS` | Comma-separated Slack user IDs allowed to use the bot | Slack profile → "Copy member ID" |
| `/bclaw/SLACK_HOME_CHANNEL` | Slack channel ID the bot treats as home | Right-click channel → "Copy link", take the trailing ID |

### Optional: GitHub authentication

Enable this (Phase 1 step 3 of the setup skill → `EnableGitHubKey=true`) only
if the agent should make authenticated `gh`/HTTPS-git calls. When enabled, the
container runs `gh auth login --with-token` on every boot; when disabled the
login is skipped and no token is injected.

| SSM key | What it is | Where to find it |
|---|---|---|
| `/bclaw/GH_TOKEN_VAL` | GitHub PAT — on-boot `gh auth login` (see setup skill Phase 6a). Named `*_VAL`, not `GH_TOKEN`, to avoid `gh`'s reserved env var | https://github.com/settings/tokens |

### Inference-provider key (choose one)

| SSM key | What it is | Where to find it |
|---|---|---|
| `/bclaw/OPENROUTER_API_KEY` | OpenRouter API key (recommended) | https://openrouter.ai/keys |
| `/bclaw/ANTHROPIC_API_KEY` | Anthropic (direct Claude API) | https://console.anthropic.com/ |
| `/bclaw/ZAI_API_KEY` | Z.AI / Zhipu (GLM) | https://z.ai/manage-apikey/apikey-list |

Create only the one matching the provider you chose in Phase 1.

Each parameter is a **SecureString** and must be encrypted with the claw's own
KMS key (alias `alias/bclaw-ssm`), created by the setup skill's CloudFormation
stack in Phase 2 — **not** the default `alias/aws/ssm`. The deployer IAM policy
pins `kms:Decrypt`/`kms:Encrypt` to `alias/bclaw-ssm` via
`kms:ResourceAliases`, so the task can only decrypt parameters this key
encrypted. A parameter left under the default SSM key fails to decrypt and the
task crash-loops. In the console's KMS key picker, type `alias/bclaw-ssm`
(substituting your claw name) — it resolves to the key the stack just created.


## Deploy

### 4. Run the setup skill

It follows a gated sequence: probe one ARM64 AZ → deploy CloudFormation (VPC,
EBS volume, EC2 container instance + Auto Scaling Group, ECS service at
DesiredCount 0 on the first deploy) → write SSM secrets → scale to 1 →
overlay `agent_home/` → verify.

`.agents/skills/setup-bclaw/SKILL.md`

Permissions are not pre-checked — if the deployer principal is missing an
action, CloudFormation surfaces the exact `is not authorized to perform` error
at deploy time (Phase 2). Fix any gap in the policy from step 2 and re-run.


## Tear down

`.agents/skills/teardown-bclaw/SKILL.md`
