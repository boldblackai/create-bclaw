# bclaw


`bclaw` is a Hermes Agent claw (a long-running gateway) deployed as a Slack
socket-mode bot. It is outbound-only — no load balancer, no inbound ports.

## Search

You can use web-search-prime to look things up that aren't obvious in the repository.


## Tooling

- Use `mise` for all tool installation (`aws-cli`, `direnv`, `jj`). Add tools
  to `mise.toml` — do not install system-wide. Activate mise in every shell:
  `eval "$(/usr/local/bin/mise activate bash)"`, then `mise trust`.
- AWS credentials live in `.env` (gitignored) and are exported by `direnv`
  (`.envrc` sources `.env`). In every shell that runs `aws`:
  ```bash
  eval "$(/usr/local/bin/mise activate bash)" \
    && eval "$(direnv hook bash)" \
    && cd /workspace \
    && eval "$(direnv export bash)"
  ```
- `.env` holds `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or `AWS_PROFILE`)
  and `AWS_REGION`. Never commit it.

## Deploy

- Deploys to **AWS ECS Fargate**, managed by the
  `setup-harness-ecs-fargate` / `teardown-harness-ecs-fargate` agent skills
  in `.agents/skills/`. The CloudFormation template lives alongside the setup
  skill at `.agents/skills/setup-harness-ecs-fargate/template.yaml`.
- No derived image is built. The signed upstream
  `ghcr.io/boldblackai/harness` image is deployed as-is — EFS supports the
  4-way mount layout directly, so no custom `Dockerfile`/`entrypoint.sh` are
  needed.
- See `README.md` for prerequisites (tooling, AWS creds, IAM, secrets).

### AWS infrastructure

- Stack name = claw name (default `bclaw`), region `us-east-1`.
- Dedicated VPC (10.0.0.0/16) with 2 public subnets across 2 AZs so Fargate
  can pick an ARM64-capable one (~20% cheaper). The setup skill probes
  Graviton AZ availability via `describe-instance-type-offerings` and passes
  the best two to the stack.
- EFS file system with 4 access points (uid/gid 1000 = the `harness` user),
  one per persisted path (`.hermes`, `.config`, mise data/state). Retained on
  stack delete (`DeletionPolicy: Retain`); the teardown skill deletes it
  explicitly after confirmation.
- Secrets are **SSM SecureString** parameters under the claw's `/bclaw/KEY`
  namespace, written by the user in setup Phase 3 (piranesi pattern). Not
  stack-owned, so they survive stack updates/deletes. 4 always-required params: `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USERS`, `SLACK_HOME_CHANNEL`. Plus opt-in keys
  chosen at deploy time: `GH_TOKEN_VAL` (optional, `EnableGitHubKey` — feeds the
  on-boot `gh auth login --with-token` in the container `Command`; skipped when
  disabled), and exactly one inference-provider key: `OPENROUTER_API_KEY`
  (recommended), `ANTHROPIC_API_KEY`, or `ZAI_API_KEY`.
- ECS service starts at `DesiredCount: 0`; the setup skill scales to 1 after
  the SSM params exist, so the gateway never crash-loops on missing env vars.
- `EnableExecuteCommand: true` → shell-in via `aws ecs execute-command` (SSM
  Session Manager). Exec sessions run as **root**; use
  `runuser -u harness --` to act as the workload user (uid 1000).
