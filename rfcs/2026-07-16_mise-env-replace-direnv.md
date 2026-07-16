# Replace direnv with mise native `.env` loading

**Date:** 2026-07-16
**Status:** Implemented

## Goal

Drop `direnv` as a managed dependency and load the deployer's `.env`
(AWS credentials + region) through mise's built-in dotenv support
(`[env] _.file = ".env"` in `mise.toml`), so a single
`eval "$(mise activate bash)"` is the only shell activation step. The
generated claw loses `.envrc` and the `.direnv/` ignore entry; `README.md`,
`AGENTS.md`, and the three skills stop describing a two-tool setup.

Closes boldblackai/create-bclaw#18.

## Motivation

Today the claw uses two tools for environment setup:

1. **mise** — installs and manages tools (`aws-cli`, `jj`, and `direnv`).
2. **direnv** — sourced `.env` into every shell via `.envrc`.

This is redundant: `direnv` is itself a tool that mise installs, purely to
source one file. Every shell that runs `aws` needs two activation steps
(`mise activate` + `direnv hook` + `direnv export`), and the template carries
`.envrc` plus matching prose across `README.md`, `AGENTS.md`, and the
`setup-bclaw` / `manage-bclaw` / `teardown-bclaw` skills.

mise already has native dotenv support. Pointing it at `.env` removes a
dependency, removes a file, and collapses two hooks into one — while the
secrets file (`.env`, gitignored) stays exactly where it is.

## POC findings

The issue asks to confirm mise can fully replace direnv. The mechanism was
verified locally against the same mise rev the generator pins behavior against
(`mise 2026.4.23`, declared indirectly via the harness image):

1. **mise `[env] _.file = ".env"` loads the file.** With this block in
   `mise.toml`, `mise env` exports every var defined in `.env`. A shell that
   runs `eval "$(mise activate bash)"` and then enters the directory gets the
   vars into its environment — no `direnv` involved.

2. **Activation behavior.** `eval "$(mise activate bash)"` followed by
   `mise trust` and a `cd` into the directory is sufficient: the `cd` is what
   triggers the env load. `mise trust` is required once before the first load
   (the shipped `mise.toml` is treated as untrusted on first contact, same as
   today's tool install). The `_.file` loader is **tolerant of a missing
   `.env`** — it exports nothing and exits cleanly, so the file's absence
   before the user copies `.env.example` does not break activation.

3. **Syntax.** mise's dotenv parser accepts both `export KEY=val` (the form
   `.env.example` ships today) and bare `KEY=val`. The shipped `export`-prefixed
   lines keep working unchanged, so `.env.example` needs only a comment
   refresh.

4. **Container context — out of scope.** direnv / `.env` feed only the **local
   deployer shell** (where `setup-bclaw` / `teardown-bclaw` / `manage-bclaw`
   run `aws`). The running ECS task does **not** read `.env`: it gets AWS
   access via its ECS task execution role and reads its secrets from SSM
   SecureStrings. So removing direnv has no effect on the deployed container —
   the migration is entirely a local-shell change.

5. **Migration surface.** The files that mention direnv / `.envrc`:

   - `template/mise.toml` — `direnv = "latest"` tool line + new `[env]` block.
   - `template/.envrc` — deleted.
   - `template/.gitignore.template` — `.direnv/` entry + its comment removed.
   - `template/.env.example` — header comment refreshed (direnv → mise).
   - `template/README.md` — Tooling line + the "Put the access key in `.env`"
     activation snippet.
   - `template/AGENTS.md` — Tooling bullet + activation snippet.
   - `template/.agents/skills/setup-bclaw/SKILL.md`,
     `template/.agents/skills/manage-bclaw/SKILL.md`,
     `template/.agents/skills/teardown-bclaw/SKILL.md` — the shared
     activation snippet (4 lines) and the `mise + direnv + AWS creds` prose.

## Technical Details

### `mise.toml`

Remove the `direnv` tool and add the dotenv pointer:

```toml
[tools]
aws-cli = "latest"
jj = "latest"
uv = "latest"

[env]
_.file = ".env"
```

Secrets are **not** inlined into `[env]` (which would put credentials in a
committed file). `_.file` points at the gitignored `.env`, keeping the
secrets-vs-config split identical to today's `direnv` sourcing.

### `.envrc` and `.gitignore.template`

- `template/.envrc` is deleted.
- `template/.gitignore.template` drops the `# direnv internal cache` comment
  and the `.direnv/` entry, keeping `.env` (still loaded by mise now, still
  gitignored).

### `.env.example`

The header comment changes from "`.envrc` sources `.env` via direnv" to
"`mise` loads `.env` via the `[env] _.file` entry in `mise.toml`". The body
(`export AWS_ACCESS_KEY_ID=…`, etc.) is unchanged — `export`-prefixed lines
parse correctly under mise's dotenv loader.

### Activation snippet

The four-line direnv block currently used in `README.md`, `AGENTS.md`, and all
three skills:

```bash
eval "$(/usr/local/bin/mise activate bash)" \
  && eval "$(direnv hook bash)" \
  && cd /workspace \
  && eval "$(direnv export bash)"
```

becomes:

```bash
eval "$(/usr/local/bin/mise activate bash)" \
  && mise trust /workspace \
  && cd /workspace
```

The `cd /workspace` is load-bearing: after `mise activate` installs the hook,
entering the directory is what triggers `[env] _.file` to be read. `mise trust`
runs once before that `cd` (the shipped `mise.toml` is untrusted on first
contact). The exact one-liner — and whether `mise trust` is folded into the
one-time Tooling step rather than the per-shell snippet — is finalized in the
integration cycle.

### Skills

The shipped skills must stay factual and present-tense (per the repo's skill
rules), so the migration rewrites them as current-state fact, not as a
migration story: "mise loads `.env` via `[env] _.file`" replaces "direnv
sources `.env`", and the `mise + direnv + AWS creds` prerequisite phrasing
becomes `mise + AWS creds`. The skills' cross-references to each other (setup
↔ manage ↔ teardown all ship together) are unaffected.

## Edge cases & risks

- **Trust ordering.** `[env] _.file` only loads once `mise.toml` is trusted,
  and the load fires on the `cd` after `mise activate`. An activation snippet
  that `cd`s before trusting prints the trust warning and loads nothing on
  that pass; the documented order (trust before `cd`) avoids it. Verified in
  the POC.
- **Secrets must stay in `.env`.** The temptation to inline `AWS_*` into the
  `[env]` table is a trap — that table ships committed. `_.file` is the
  correct boundary (gitignored target).
- **`AWS_PROFILE` alternative.** The commented `AWS_PROFILE` line in
  `.env.example` is just another env var; mise loads it identically. No
  special handling.
- **Existing deployments are unaffected.** The generator governs only new
  scaffolds. A claw already generated with direnv keeps its `.envrc` and keeps
  working until it is regenerated; nothing is redeployed.
- **Golden test.** All changes are inside `template/`, so they flow through the
  existing golden test. Invariant 1 (`create-bclaw bclaw` == `template/`
  byte-for-byte) is what proves the edits landed correctly; no new test
  mechanism is needed. The edits introduce no new `bclaw` / `us-east-1`
  tokens, so the existing residual assertions are unaffected.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| **mise `[env] _.file = ".env"` (this RFC)** | **Chosen** — one activation step, one fewer managed tool, removes a file. Secrets stay in the gitignored `.env`; mechanism verified in the POC. |
| **Status quo (keep direnv)** | Rejected — direnv is a mise-managed tool whose only job is to source one file; the indirection (mise installs direnv to source `.env`) is circular, and the two-step activation is duplicated across five files. |
| **Inline `AWS_*` into `mise.toml` `[env]`** | Rejected — puts credentials in a committed file. `_.file` keeps the secrets/config split intact. |
| **Drop `.envrc`, keep sourcing `.env` manually in each skill** | Rejected — reintroduces per-command ceremony (`set -a; . ./.env; set +a`) and is not global to the shell, so ad-hoc `aws` calls outside a skill's snippet lack the creds. mise's `_.file` is global to the activated shell. |

## Migration Notes

- **Integration cycle required.** This is a `template/` hand-edit change (not
  an automatic generator transform), so it must be validated live in
  `/alt/integration`: remove `direnv` from `mise.toml`, delete `.envrc`, add
  the `[env]` block, regenerate, and confirm `aws sts get-caller-identity`
  works from a mise-only shell. Then exercise a deploy, a shell-in
  (`manage-bclaw`), and teardown to confirm the skills' updated activation
  snippet holds.
- **Journal:** record issues in
  `/workspace/references/integrations/2026-07-16_mise-env-replace-direnv.md`.
- **Port-back:** after the live check, reconcile
  `diff -rq /workspace/template /alt/integration
  --exclude=.git --exclude=.agents/skills --exclude=node_modules --exclude=dist`
  and confirm `.envrc` is gone on both sides and `mise.toml` matches.
- **Existing deployments:** unaffected — a claw already using direnv keeps
  working until regenerated; the generator only governs new scaffolds.
- **Generator-repo `AGENTS.md`:** the integration-layout note that describes
  `/alt/integration` as having "aws access via direnv" should be refreshed to
  "aws access via mise" once the integration repo is migrated.

## Implementation Notes

All template edits landed; `grep -rn -i 'direnv\|\.envrc\|\.direnv'
template/ README.md AGENTS.md` returns nothing.

### Files changed

- `template/mise.toml` — dropped the `direnv` tool; added `[env] _.file =
  ".env"`.
- `template/.envrc` — deleted.
- `template/.gitignore.template` — dropped the `.direnv/` entry + its comment
  (kept `.env`, now loaded by mise).
- `template/.env.example` — header comment now says mise loads `.env` via
  `[env] _.file`.
- `template/README.md`, `template/AGENTS.md` — Tooling tool list drops
  `direnv`; the per-shell activation snippet is now `mise activate && mise
  trust /workspace && cd /workspace`.
- `setup-bclaw` / `manage-bclaw` / `teardown-bclaw` skills — same snippet
  swap, and the `mise + direnv + AWS creds` prerequisite phrasing became
  `mise + AWS creds`.
- Generator-repo `AGENTS.md` — the `/alt/integration` layout note now reads
  "aws access via mise".

### Activation snippet — finalized

The per-shell snippet is `eval "$(mise activate bash)" && mise trust
/workspace && cd /workspace`. Verified the load fires three ways: activate +
trust + cd from outside the dir; activate alone when already inside the dir
(the precmd hook picks up `[env] _.file` on the next prompt); and tolerate a
missing `.env` (exports nothing, no error). `mise trust` stays in the snippet
(rather than only the one-time Tooling step) so each skill is self-contained
on a fresh clone; its output is a single `mise trusted /workspace` line.

### Correctness — golden test

`pnpm test` is 17/17 green. Invariant 1 (`create-bclaw bclaw` output ==
`template/` byte-for-byte) confirms the template edits landed correctly with
no drift; the edits introduce no new `bclaw` / `us-east-1` tokens, so the
existing residual assertions are unaffected.

### Mechanism verified on a generated claw

Generated `testclaw` from the patched generator and confirmed, with **no
direnv installed anywhere**, that `mise` alone loads `.env`: a stub `.env`
with `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` reached the
shell after `mise activate` + `mise trust` + `cd`, and after `mise activate`
alone when already in the dir. The generated `mise.toml` reads `[env] _.file
= ".env"` and the generated claw has no `.envrc`.

### Verification — live `aws sts` confirmed

The live `aws sts get-caller-identity` check (the issue's acceptance
"verify `aws` commands work") was not run in the implementation sandbox
(no `/alt/integration` repo, no `AWS_*` credentials, no `aws-cli`/`direnv`
binaries — only `mise`); the env-loading path was proven end-to-end on a
generated claw there. It was then confirmed in a credentialed environment:
`/alt/integration` was migrated to the new config and `aws sts
get-caller-identity` was run from a mise-only shell (`direnv` not installed
anywhere), returning the deployer identity
(`arn:aws:iam::<AWS_ACCOUNT_ID>:user/otacon-deployer`). See the integration
journal, `references/integrations/2026-07-16_mise-env-replace-direnv.md`.
