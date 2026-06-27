# bclaw CLI scaffolder (`@boldblackai/create-bclaw`)

**Date:** 2026-06-27
**Status:** Proposed

## Goal

Ship an `npx`-distributed CLI that generates a renamed skeleton of
`references/bclaw-repo`. Running `npx @boldblackai/create-bclaw foo` (or
`npm init @boldblackai/bclaw foo`) produces a `foo/` directory whose contents
match `references/bclaw-repo` except every `bclaw` reference — file contents
and file/directory names, including the SSM namespace, IAM scopes, and KMS
alias — is renamed to `foo`.

## Motivation

`bclaw` was originally a single hardcoded instance: its SSM namespace
(`/bclaw/`), IAM policy scope (`parameter/bclaw/*`), KMS alias
(`alias/bclaw-ssm`), and docs all assumed exactly one claw per AWS account.
That constraint existed only because there was no programmatic way to mint
additional claws. This repo is that mechanism: the generator exists to end
the single-claw limitation by producing a correctly-renamed claw on demand.

## Technical Details

### Identity & invocation (CRA-style, scoped)

- **Package:** `@boldblackai/create-bclaw` (scoped, following the
  `@boldblackai/*` naming used across the patterns' reference repos).
- **Bin:** `create-bclaw`.
- **Invocation:** `npx @boldblackai/create-bclaw foo` or, equivalently,
  `npm init @boldblackai/bclaw foo` (npm's `create-*` initializer convention).
- **No subcommand:** the project name is a direct positional argument
  (`create-bclaw foo`), matching `create-react-app`'s shape. (`bclaw new foo`
  is explicitly *not* the invocation.)
- **No-arg behavior:** if no name is given, prompt for one via clack `text()`
  rather than erroring.
- **Name validation:** `^[a-zA-Z][a-zA-Z0-9-]*$`, length 1–**59**. The name
  becomes the CloudFormation stack name, IAM role prefix (`<name>-exec`,
  `<name>-task`), ECS cluster/service, log group, SSM namespace (`/<name>/`),
  KMS alias (`alias/<name>-ssm`), and EFS tag (`<name>-data`). The ceiling is
  **59**, not the template's current `MaxLength` of 63, because IAM role names
  cap at 64 chars and the `-exec`/`-task` suffix consumes 5. Mixed case is
  allowed (matches `ClawName`'s `[a-zA-Z]`); no reserved-name blocking.
- **Target directory:** refuse a non-empty target dir by default; `--force`
  overrides (create-react-app parity).

### Rename model

- **Single rename token:** literal lowercase `bclaw` → `<name>`, applied to
  text file contents **and** path components (`bclaw-deploy-policy.json` →
  `foo-deploy-policy.json`). Every `bclaw` occurrence in the source is
  lowercase and standalone (no `Bclaw`, no glued substrings), so a literal
  substring replace is mechanically safe and produces output identical to a
  word-boundary replace on this data.
- **SSM namespace renames too** (this is the load-bearing decision): `/bclaw/`
  → `/<name>/`, `parameter/bclaw/*` → `parameter/<name>/*`, `alias/bclaw-ssm`
  → `alias/<name>-ssm`. This is what makes multiple claws coexist in one AWS
  account (disjoint stacks, roles, namespaces, KMS aliases, EFS tags).
- **Immutable tokens (never touched):** `harness` (uid-1000 user,
  `*-harness-ecs-fargate` skill names, `HARNESS_CLOUD_MODE`,
  `HERMES_HOME=/home/harness/.hermes`), `hermes` (container name,
  `exec hermes gateway`), and `boldblackai` / `BoldBlack AI` (including the
  real artifact URL `ghcr.io/boldblackai/harness`). A `bclaw`-only replace
  cannot reach these. BoldBlack AI display branding stays hardcoded for v1;
  a second `org` token is a clean future add that does not change the v1
  architecture.

### Template source & scope

- **Bundle a snapshot.** `references/bclaw-repo` (verbatim, minus `.git` and
  `.env`) ships as a `template/` directory inside the npm package. At runtime,
  the CLI copies `template/` → `./<name>/` and applies the `bclaw`→`<name>`
  replace. Runtime `git clone` is rejected: it needs git+network during `npx`,
  fails offline, and "which ref?" breaks reproducibility — colliding with the
  patterns' pin-everything philosophy.
- **`template/` lives outside `src/`** so P006's `tsc` does not compile it and
  Biome does not lint it; it is listed in `package.json#files` and added to
  `biome.json#files.ignore`.
- **`scripts/sync-template`** refreshes `template/` from
  `references/bclaw-repo` (excludes `.git`, `.env`; keeps `.envrc`). It is the
  single source of truth; the snapshot is a derived artifact.
- **Scaffold-only scope.** The generator produces the renamed directory and
  stops. It does **not** run the setup/teardown skills, touch AWS or Slack,
  prompt for tokens, or run `mise install` — those belong to the bundled
  skills' setup flow. (Unlike CRA, the generated output is not a Node project,
  so there is no dependency install step.)
- **Generated-repo VCS:** the CLI runs `git init` + an initial commit in the
  generated dir (git, not jj). `.envrc` is included verbatim. A `.env.example`
  stub is also shipped — it documents the `.env` shape the user must fill in
  (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`, with the
  `AWS_PROFILE` alternative noted), so the consumer `cp`s it to `.env` and
  edits. The real `.env` stays gitignored (never committed); `.env.example`
  holds placeholders only, so it IS committed.
- **Post-generation output:** clack `outro` prints concrete next steps
  (`cd <name>` → `mise install && mise trust` → follow README Setup → run the
  setup skill).

### Source-template fixes (applied to `references/bclaw-repo`)

Because `references/bclaw-repo` is owned by this repo, correctness is fixed at
the source so the snapshot is already correct and literal-rename is the whole
transform:

1. **`ClawName.MaxLength` 63 → 59** in
   `references/bclaw-repo/.agents/skills/setup-harness-ecs-fargate/template.yaml`,
   so deploy-time validation agrees with the generator's 59-char ceiling.
2. **Delete the static-namespace / one-claw-per-account prose** (not rewrite)
   from the source — it is an artifact of the single-claw era and is now false.
   Sites: `README.md` (×3), `AGENTS.md`, setup `SKILL.md` (Phase 1 & 3), and
   the `template.yaml` comments that justify the hardcoded `/bclaw/` prefix.
3. **Add `.env.example`** to `references/bclaw-repo` — a committed,
   placeholder-only stub documenting the `.env` shape
   (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`, with an
   `AWS_PROFILE` alternative comment). The consumer copies it to `.env` and
   fills in real values. (`.env` itself stays gitignored.) Currently
   `references/bclaw-repo` ships `.envrc` but no example stub.

### Verification (the correctness proof)

The product *is* "rename `bclaw`→`<name>` completely," so verification is
load-bearing:

- **Hard post-copy assertion:** after writing, assert **zero** residual `bclaw`
  literals in the output (fail loud). Once the source prose is deleted (above),
  "no `bclaw` remains" is a *sufficient* correctness check — there is no
  false prose surviving rename that lacks the literal word.
- **Golden CI test** with three invariants:
  1. `create-bclaw bclaw` output == `template/` byte-for-byte (rename is a
     no-op when name == `bclaw`; proves the copy is faithful).
  2. `create-bclaw foo` output == (`create-bclaw bclaw` output with
     `bclaw`→`foo`) (proves the rename is complete and is the *only* delta).
  3. `grep -r bclaw` on the `foo` output == empty (the hard assertion,
     enforced independently).

### Tooling stack (patterns P002–P006, P009)

The generator's own toolchain is fully determined by the capotej/patterns
conventions — not a design choice:

- **TypeScript + `tsc`** (P006): `strict`, single `src/` root, `outDir`,
  `declaration`, `types: ["node"]`, `esModuleInterop`, `skipLibCheck`,
  `target: ES2022`, `module/moduleResolution: NodeNext`; Node 22 LTS.
- **pnpm** (P004): declared via `packageManager` (exact pin), committed
  `pnpm-lock.yaml`, gitignored `.pnpm-store`.
- **Biome** (P005): exact-pinned devDep, version-matched `$schema`, ignore
  `node_modules/`, `.pnpm-store/`, `dist/`, `template/`; `lint`/`lint:fix`/
  `format` scripts.
- **mise** (P003): `mise.toml` source of truth for non-Node CLIs.
- **actionlint** (P009): provisioned via mise (`github:rhysd/actionlint`),
  committed `.actionlint.yaml` with commented ignores, invoked bare.
- **SHA-pinned GitHub Actions** (P002): every third-party `uses:` pinned to a
  40-char SHA with a `# <tag>` comment.

### Publishing

Manual `npm publish` from a maintainer's machine (no release workflow for v1).
CI still gates lint + typecheck + the golden test on every push/PR; publishing
is a deliberate human step.

## Migration Notes

- The `references/bclaw-repo` source changes (`MaxLength` 63→59, prose
  deletion) are made in the same change that introduces the generator, so the
  first snapshot is already correct.
- Existing single-claw `bclaw` deployments are unaffected: they keep their
  `/bclaw/` namespace and IAM scope; the generator only governs *new* claws.

## Implementation Checklist

- [ ] `package.json`: `name: @boldblackai/create-bclaw`, `bin: create-bclaw`,
      `packageManager: pnpm@<exact>`, `type: module`, `files: [dist, template]`,
      scripts (`build`, `prepare`, `lint`, `lint:fix`, `format`, `sync:template`,
      `test`); `dependencies: @clack/prompts`; `devDependencies: typescript,
      @types/node, @biomejs/biome`.
- [ ] `tsconfig.json` per P006 (strict, NodeNext/ES2022, `src`→`dist`).
- [ ] `biome.json` per P005 (ignore `template/`, `dist/`, caches).
- [ ] `mise.toml` per P003 (node 22, actionlint via github source).
- [ ] `src/cli.ts`: clack `intro`/`text`/`confirm`/`outro`, arg parsing,
      `--force`/`--version`/`--help`, name validation (`^[a-zA-Z][a-zA-Z0-9-]*$`,
      ≤59), refuse-non-empty-dir.
- [ ] `src/generate.ts`: copy `template/` → `./<name>/`, literal `bclaw`→`<name>`
      on contents + path components, hard "no `bclaw` remains" assertion,
      `git init` + initial commit.
- [ ] `scripts/sync-template`: copy `references/bclaw-repo` → `template/`
      (exclude `.git`, `.env`).
- [ ] Fix `references/bclaw-repo/.../template.yaml`: `ClawName.MaxLength` 63→59.
- [ ] Delete static-namespace/one-claw-per-account prose from
      `references/bclaw-repo` (README ×3, AGENTS.md, setup SKILL.md, template
      comments).
- [ ] Add `references/bclaw-repo/.env.example` (placeholders for
      `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`, `AWS_PROFILE`
      alt as comment; `.env` stays gitignored).
- [ ] Golden test (invariant 1/2/3 above).
- [ ] CI workflow: Biome + actionlint lint, `tsc --noEmit`, golden test on
      Node 22; SHA-pinned actions (P002).
- [ ] `.actionlint.yaml` (P009); `.gitignore` (`node_modules/`, `.pnpm-store`,
      `dist/`).
- [ ] Package `README.md` with `npx`/`npm init` usage.
