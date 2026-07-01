# AGENTS.md

## Rules

* Use a TDD workflow when writing code.

## RFCs

Significant changes, architectural decisions, and new features should be proposed as RFCs in the `rfcs/` directory. RFCs use the format `rfcs/YYYY-MM-DD_short_title.md` with the following structure:

- `# Title` — short descriptive title
- `**Date:**` — proposal date (ISO format)
- `**Status:**` — `Proposed`, `Accepted`, `Implemented`, or `Rejected`
- `## Goal` — what the RFC aims to accomplish
- Remaining sections are free-form but typically include motivation, technical details, migration notes, and an implementation checklist
- When moving an RFC to `Implemented`, update `AGENTS.md` and `README.md` to reflect any new infrastructure, commands, or workflows introduced by the RFC. Also, replace the implementation checklist with implementation notes.

## Overview

This repo is `@boldblackai/create-bclaw`, an `npx`-distributed CLI that
generates a renamed skeleton of a Hermes Agent claw repo. Running
`npx @boldblackai/create-bclaw foo` produces a `foo/` directory whose contents
match the bundled `template/` snapshot except every lowercase `bclaw` reference
— file contents and file/directory names, including the SSM namespace, IAM
scopes, and KMS alias — is renamed to `foo`. See
`rfcs/2026-06-27_bclaw-cli-scaffolder.md` for the full design.

- `template/` is the **source of truth** (a Hermes Agent claw repo snapshot)
  shipped inside the npm package; edit it directly.
- `src/` is the generator (`cli.ts` + `generate.ts`); `test/golden.test.mjs` is
  the correctness proof.

## Skills

Skills ship inside `template/.agents/skills/` and are consumed by the generated
claw, so their content must be **factual and present-tense** — instructional
steps and current-state facts only.

- **No historical or changelog narrative.** Do not write "previously gated
  on…", "was migrated from X to Y", "future template improvement: …", "the old
  behavior", or similar past/future-state framing in shipped skill files (the
  `SKILL.md`, plus shipped supporting files like `template.yaml` and
  `scripts/`).
- **No war-story framing.** Keep findings as stated facts, not discovery
  narrative ("a real deploy hit…", "near-miss from…", "bit a real deploy",
  "we discovered…").
- **Discovery narratives, "why" background, migration histories, and
  lessons-learned belong in the repo-level `references/` directory** (not
  inside `template/`). Those docs are for authors of this repo and do not ship
  in the generated claw. Never cite `references/` from shipped skill content —
  each skill must be self-contained **relative to what ships**: a skill may
  reference a sibling skill under `template/.agents/skills/` (the setup /
  manage / teardown skills always ship together in the generated claw, so
  cross-references between them are stable and preferred over duplicating
  shared procedure), but it must never depend on author-only docs, scripts, or
  state that won't be present in the generated repo.

## Tool Versions

This project uses `mise.toml` as the single source of truth for all tool and
language versions. Do not install tools globally or via ad-hoc commands — use
mise instead.

- Activate mise before running commands: `eval "$(mise activate bash)"`
- Install all declared tools: `mise install` (then `mise trust` on a fresh clone)
- Run one-off commands with correct versions: `mise exec -- <command>`

`mise.toml` pins `node` and `github:rhysd/actionlint`. pnpm is **not** a mise
tool — it is managed by corepack via the `packageManager` field (see Package
Manager). If you change a tool version, update `mise.toml` and run `mise install`
to apply.

## Package Manager

This project uses **pnpm**, declared via the `packageManager` field in
`package.json`. Do not use npm or yarn.

- Install dependencies: `pnpm install`
- Add a dependency: `pnpm add <pkg>` (updates `pnpm-lock.yaml`)
- Add a dev dependency: `pnpm add -D <pkg>`
- Run a script: `pnpm <script>` or `pnpm run <script>`
- In CI or to enforce the lockfile: `pnpm install --frozen-lockfile`

The pnpm version is pinned in `package.json` (`"packageManager": "pnpm@11.9.0"`)
and read automatically by corepack. `pnpm-lock.yaml` is committed and is the
source of truth for the dependency tree; `.pnpm-store/` is a cache and is
gitignored.

## Linting and Formatting

This project uses **Biome** for both linting and formatting
TypeScript/JavaScript. Do not introduce eslint, prettier, or editor-specific
config.

- Check for violations: `pnpm lint` (runs `biome check .`)
- Auto-fix lint issues: `pnpm lint:fix` (runs `biome check --write .`)
- Format only: `pnpm format` (runs `biome format --write .`)

Configuration lives in `biome.json`. The `@biomejs/biome` version is pinned
exactly in `package.json` devDependencies; the `$schema` URL in `biome.json`
must match that version — if you bump Biome, bump both in the same change.
`biome.json` ignores `dist/` and `template/` (via `vcs.useIgnoreFile`
+ explicit excludes) so the compiled output and bundled snapshot are never linted.

Before finishing any code change, run `pnpm lint`.

## TypeScript

This project is written in TypeScript and compiled with `tsc` (no babel/swc).
Configuration lives in `tsconfig.json`; `strict` mode is on — do not disable it
or weaken individual strict flags.

- Build (compile + emit declarations): `pnpm build`
- Typecheck only, no emit: `pnpm exec tsc --noEmit`
- Source lives in `src/` and compiles to `dist/`; do not add TypeScript outside
  `src/`. `template/` lives outside `src/` on purpose so it is never compiled.

## GitHub Actions

All third-party action references in `.github/workflows/` must be pinned to their
full 40-character commit SHA with a version tag in a trailing comment:

    uses: owner/repo@<sha> # <tag>

Never use tag-only references (e.g. `actions/checkout@v5`). When adding or
updating an action, resolve the tag to a SHA using
`gh api repos/OWNER/REPO/commits/TAG --jq '.sha'` or
`git ls-remote https://github.com/OWNER/REPO.git refs/tags/TAG`. Local composite
actions (`./.github/actions/*`) are exempt.

## GitHub Actions Linting

This project lints `.github/workflows/*.yml` with **actionlint**. The tool is
installed via mise (`"github:rhysd/actionlint" = "v1.7.12"` in `mise.toml`), not
via pnpm — activate mise before running it. actionlint also runs shellcheck on
every `run:` block.

Configuration lives in `.actionlint.yaml`. New workflow files are discovered
automatically — no file arguments needed. The CI install step receives the bare
version (`1.7.12`) and it must match mise's `v1.7.12` tag; when it changes,
update `mise.toml` first and the CI step second.
