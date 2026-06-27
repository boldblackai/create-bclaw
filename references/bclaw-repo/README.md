# bclaw

A Hermes Agent claw — a long-running gateway deployed as a Slack socket-mode
bot. It is outbound-only: no load balancer, no inbound ports. The Slack app
manifest lives in `slack-manifest.json`.

Runs on AWS ECS Fargate. Deployed and torn down via the agent skills in
`.agents/skills/`.


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

**Substitute the claw name.** The policy is written for the default claw name
`bclaw`. The name appears in every pinned resource path (`stack/bclaw`,
`role/bclaw-*`, `cluster/bclaw`, `service/bclaw/*`, `log-group:/ecs/bclaw*`),
the EFS tag value (`bclaw-data`), and the KMS alias (`alias/bclaw-ssm`). If
the claw name is different, substitute it everywhere before attaching. Then
re-attach via the console (editing the file alone doesn't update the attached
policy).

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
| `EC2Networking` | VPC/subnet/IGW/route-table/SG ARNs use AWS-assigned IDs (`vpc-xxx`, `subnet-xxx`, `sg-xxx`). The `Name` **tag** is set by the template but is NOT part of the ARN — so no prefix to pin. `ec2:Describe*` actions additionally don't support resource-level permissions at all (AWS requires `*`). |
| `EFSDescribe` | `DescribeFileSystems`/`DescribeAccessPoints` are List-type actions that don't support resource-level conditions. Read-only — the sensitive delete/mutate EFS actions ARE tag-conditioned (see below). |
| `ECSTaskDefsAndTasks` | **Task definitions do not support resource-level permissions** (confirmed in the AWS ECS authorization reference) — `RegisterTaskDefinition`/`DescribeTaskDefinition`/`DeregisterTaskDefinition` must be `*`. `DescribeTasks`/`ListTasks` operate on tasks with runtime-assigned IDs. (Clusters and services DO support RLP and are pinned in `ECSScoped`.) |
| `LogsDescribe` | `logs:DescribeLogGroups` is a list action that doesn't support resource-level. The sensitive write actions (`CreateLogGroup`/`DeleteLogGroup`/`PutLogEvents`) are pinned in `LogsScoped`. |
| `SSMDescribe` | `ssm:DescribeParameters` is a list action, no resource-level support. The actual secret reads/writes are pinned in `SSMSecrets`. |
| `SSMMessages` | Amazon Message Gateway Service (`ssmmessages`) does not support resource-level permissions at all — AWS requires `Resource: "*"` for all four channel actions. Needed for `aws ecs execute-command` (ECS Exec). The sensitive `ecs:ExecuteCommand` itself IS scoped to bclaw tasks/cluster (`ECSExec`); the ssmessages channels cannot be narrowed further. |
| `KMSCreateKey` | `kms:CreateKey` creates a not-yet-existing key — no ARN to pin. `kms:CreateAlias`/`kms:DeleteAlias` operate on the key being created/deleted. `kms:PutKeyPolicy`/`kms:EnableKeyRotation`/`kms:DescribeKey` are needed during key creation — **before the alias exists**, so they CANNOT be alias-conditioned (a common deploy failure). These are one-time setup operations (not data access); the sensitive `kms:Decrypt`/`kms:Encrypt` ARE alias-conditioned (see below). |

**Tag-conditioned `Resource: "*"` statements** (ABAC pattern — `*` with a
condition that restricts to our resources only):

| Statement | Condition | What it protects |
|---|---|---|
| `EFSFileSystemManage` | `aws:ResourceTag/Name = bclaw-data` | Can only delete/mutate the claw's own EFS file system + mount targets + create access points on it. Cannot touch any other EFS in the account. |
| `EFSFileSystemCreate` | `aws:RequestTag/Name = bclaw-data` | Can only create an EFS file system if it's tagged `Name=bclaw-data`. Prevents creating arbitrary EFS. |
| `EFSAccessPointDelete` | `aws:ResourceTag/Name = bclaw-data` | Can only delete access points tagged `Name=bclaw-data` (the template tags all 4 APs). Cannot delete any other access point. |
| `KMSUseKey` | `kms:ResourceAliases = alias/bclaw-ssm` | Can only Decrypt/Encrypt/ScheduleKeyDeletion on the claw's own CMK. Cannot use any other KMS key in the account. (Note: `kms:DescribeKey` and `kms:EnableKeyRotation` were moved to `KMSCreateKey` because the alias doesn't exist during key creation — see above.) |

#### Notes

- **Shell-in (ECS Exec) permissions are included.** The policy grants
  `ecs:ExecuteCommand` scoped to the bclaw cluster + tasks (`ECSExec`), plus the
  four `ssmmessages:*` channel actions (`SSMMessages`). These are needed by the
  setup skill (Phase 5), teardown skill, and the `manage-harness-ecs-fargate`
  skill. `ssmmessages:*` cannot be resource-scoped — see the "Why some resources
  stay `Resource: *`" table below.

  AWS additionally recommends **denying** `ssm:StartSession` on ECS tasks
  (`DenyDirectSSMSession`). Sessions started via `ecs:ExecuteCommand` are logged;
  sessions started via `ssm:StartSession` bypass ECS Exec logging and consume the
  session quota. The deny blocks only direct SSM sessions on bclaw tasks — it
  does not affect `ecs:ExecuteCommand` (different API path).
- **`SimulateSelf` for roles.** The `bclaw-deploy` policy's `SimulateSelf`
  statement uses `${aws:username}`, which only resolves for IAM users. If you
  attach the policy to a *role*, change that Resource to `*` or the role's ARN.
- **One claw per account.** The static `/bclaw/` SSM namespace means two
  claws in the same AWS account collide. That's the trade-off for the
  deterministic IAM scope.

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

The claw needs SSM SecureString parameters under the static `/bclaw/`
namespace (not the claw name). You'll enter them in the AWS console during the
setup skill (Phase 3) — they're not CloudFormation resources, so they survive
stack updates and deletes. Five are always required; plus exactly one
inference-provider key (you'll choose which in Phase 1 of the setup skill).
Gather the values beforehand:

### Always required

| SSM key | What it is | Where to find it |
|---|---|---|
| `/bclaw/SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-`) | Slack app → OAuth & Permissions → Bot User OAuth Token |
| `/bclaw/SLACK_APP_TOKEN` | Slack app-level token (`xapp-`, enables socket mode) | Slack app → Basic Information → App-Level Tokens |
| `/bclaw/SLACK_ALLOWED_USERS` | Comma-separated Slack user IDs allowed to use the bot | Slack profile → "Copy member ID" |
| `/bclaw/SLACK_HOME_CHANNEL` | Slack channel ID the bot treats as home | Right-click channel → "Copy link", take the trailing ID |
| `/bclaw/GH_TOKEN_VAL` | GitHub PAT — on-boot `gh auth login` (see setup skill Phase 5a) | https://github.com/settings/tokens |

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

> **One claw per account.** The `/bclaw/` namespace is static, so two claws
> in the same AWS account would collide on the same SSM parameters. That's the
> trade-off for the deterministic IAM scope.


## Deploy

### 4. Run the setup skill

It follows a gated sequence: probe ARM64 AZs → deploy CloudFormation (VPC, EFS,
ECS service at DesiredCount 0) → write SSM secrets → scale to 1 → verify.

`.agents/skills/setup-harness-ecs-fargate/SKILL.md`

The skill opens with a `simulate-principal-policy` pre-flight that checks the
deployer principal has every action the stack needs. If it lists any `denied`
actions, the policy from step 2 is incomplete or not re-attached — fix it and
re-run.


## Tear down

`.agents/skills/teardown-harness-ecs-fargate/SKILL.md`
