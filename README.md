# @boldblackai/create-bclaw

Scaffold a renamed **Hermes Agent claw** — a long-running Slack socket-mode
gateway deployed on AWS ECS Fargate. Given a name, this CLI produces a working
claw repo with every `bclaw` reference (file contents **and** file/directory
names, including the SSM namespace, IAM scopes, and KMS alias) renamed to that
name, so multiple claws can coexist in one AWS account.

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

### What you get

`./<name>/` — a renamed snapshot of the bundled `template/` (a Hermes Agent claw
on ECS Fargate), with an initial git commit already made. Then:

```bash
cd <name>
mise install && mise trust
# follow README.md → Setup (IAM user, deploy policy, .env, Slack app, secrets)
# run the setup-harness-ecs-fargate skill to deploy
```

The generator is **scaffold-only**: it produces the renamed directory and stops.
It does not run the setup/teardown skills, touch AWS or Slack, prompt for
tokens, or run `mise install` — those belong to the bundled skills' setup flow.

## How the rename works

The bundled `template/` is the source of truth — a Hermes Agent claw on ECS
Fargate, shipped inside the package. At runtime the CLI copies `template/` → `./<name>/`
and applies a single literal replace — lowercase `bclaw` → `<name>` — to text
file contents and path components. Every `bclaw` in the source is lowercase and
standalone, so a literal substring replace is the whole transform and is
verified by a hard post-copy assertion (zero residual `bclaw`).

One wrinkle: npm's packlist silently drops any file literally named
`.gitignore`, so the snapshot ships it as `.gitignore.template` and the
generator strips the `.template` suffix on materialize (`prod-claw/.gitignore`).
Any future file npm would drop is handled the same way — name it `*.template`
in `template/` and it materializes correctly.

The immutable tokens `harness`, `hermes`, and `boldblackai`/`BoldBlack AI`
(including the upstream image `ghcr.io/boldblackai/harness`) are never touched —
a `bclaw`-only replace cannot reach them.

## Development

Toolchain is governed by [capotej/patterns](https://github.com/capotej/patterns)
conventions: TypeScript + `tsc` (P006), pnpm (P004), Biome (P005), mise (P003),
actionlint (P009), SHA-pinned Actions (P002).

```bash
pnpm install          # installs deps + builds dist/ (prepare)
pnpm build            # tsc
pnpm exec tsc --noEmit  # typecheck only
pnpm lint             # biome check .
pnpm test             # tsc && node --test (golden test)
```

### Publishing

Manual `npm publish` from a maintainer's machine (no release workflow for v1).
CI gates lint + typecheck + the golden test on every push/PR; publishing is a
deliberate human step.

## License

MIT
