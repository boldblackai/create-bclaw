# @boldblackai/create-bclaw

Create a repository for your own bclaw, deployed to your own AWS account.

## What is a bclaw?

bclaw is short for "**B**usinessClaw": an opinionated deployment of [hermes-agent](https://hermes-agent.nousresearch.com/) configured as a 
long-running ["claw"](https://www.cnet.com/tech/services-and-software/claw-ai-explainer-openclaw-nvidia/) within your Slack workspace.

Create, customize and deploy as many as you'd like. Each generated bclaw repository corresponds to one specific long-running agent and Slack application/user.

For example, you could generate a `@swe-pal` for a "Devin" type experience: code reviews, pull requests, etc. Or, a `@reportclaw` that posts reports at scheduled times to configured channels.

## How it works

1. Generate your bclaw repository

    npx @boldblackai/create-bclaw swe-pal

2. Follow the instructions in the README to create the IAM user and policy to get the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for `.env`. This also
walks you through creating and installing the Slack app into your workspace to get the `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` you'll need later.

3. The generated repository is a set of skills, so open up `swe-pal` in your favorite harness ([Pi](https://boldblackai.github.io/harness/agents/pi/), [Hermes](https://boldblackai.github.io/harness/agents/hermes/), [OpenCode](https://boldblackai.github.io/harness/agents/opencode/))

4. Run the `/setup-bclaw` skill. This will prompt you for an inference provider, it supports [OpenRouter](https://openrouter.ai/), [ZAI](https://z.ai/subscribe), and [Anthropic](https://www.anthropic.com/) out of the box, but trivial 
to use any that [hermes-agent already supports](https://hermes-agent.nousresearch.com/docs/integrations/providers/).

5. To manage it (update running image version, update skills/SOUL.md, etc) you can use the `/manage-bclaw` skill.

6. To uninstall it, run the `/teardown-bclaw` skill.

## What you get

* [hermes-agent](https://hermes-agent.nousresearch.com/docs) running on ECS Fargate via our [hardened](https://boldblackai.github.io/harness/security/) [harness](https://github.com/boldblackai/harness) Docker image.

* GitHub & Slack integration

* Persisted and backed up via AWS EFS.


## Usage

```bash
npx @boldblackai/create-bclaw <name>
# or equivalently
npm init @boldblackai/bclaw <name>
```

If no name is given (and stdin is a TTY), you'll be prompted for one.

`<name>` must match `^[a-zA-Z]([a-zA-Z0-9-]*[a-zA-Z0-9])?$` and be 1–59 characters. It becomes
the CloudFormation stack name, IAM role prefix (`<name>-exec`, `<name>-task`),
ECS cluster/service, log group, SSM namespace (`/<name>/`), KMS alias
(`alias/<name>-ssm`), and EFS tag (`<name>-data`). The 59-char ceiling keeps the
`-exec`/`-task` role suffixes under IAM's 64-char role-name limit.

### Options

- `--force` — generate into a non-empty target directory, merging with existing files (default: refuse).
- `--version`, `-V` — print the version.
- `--help`, `-h` — show help.


## Development

```bash
pnpm install          # installs deps + builds dist/ (prepare)
pnpm build            # tsc
pnpm exec tsc --noEmit  # typecheck only
pnpm lint             # biome check .
pnpm test             # tsc && node --test (golden test)
```

### Publishing

Run `npm publish`

## License

MIT
