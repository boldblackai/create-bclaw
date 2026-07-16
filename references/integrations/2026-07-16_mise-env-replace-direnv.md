# Integration cycle: replace direnv with mise native `.env` loading

**Date:** 2026-07-16
**Status:** Done
**RFC:** [2026-07-16_mise-env-replace-direnv.md](../../rfcs/2026-07-16_mise-env-replace-direnv.md)

## Entries

### 2026-07-16 — `/alt/integration` absent; no AWS access in sandbox

The integration-cycle environment (`/alt/integration`) does not exist in this
sandbox, and there is no AWS access — no `AWS_*` env vars, no `aws-cli` /
`direnv` binaries (only `mise`). The live `aws sts get-caller-identity` check
the RFC's acceptance criteria call for could not be run here.

Substituted a local mechanism verification: generated `testclaw` from the
patched generator and confirmed `mise` alone loads `.env` (all three
`AWS_*` vars reach the shell via `[env] _.file`, no `direnv`). The credential-
validity step (the actual `aws sts` round-trip) is deferred to a shell with
the deployer key. See the RFC's Implementation Notes → "Verification gap".

### 2026-07-16 — live `aws sts` verified; verification gap closed

Ran the RFC's acceptance check in an environment with `/alt/integration`, a
real `.env`, and `aws-cli`: migrated `/alt/integration` to the new config
(dropped `direnv` from `mise.toml`, added `[env] _.file = ".env"`, deleted
`.envrc`, refreshed `.gitignore` + `.env.example` comments to match the
ported-back template), then from a mise-only shell (`direnv` is not installed
anywhere — so the mise-native path is forced) ran `aws sts
get-caller-identity`. It returned the deployer identity
(`arn:aws:iam::<AWS_ACCOUNT_ID>:user/otacon-deployer`) after the `AWS_*` vars
reached the shell via `[env] _.file`. The migration's acceptance criterion is
now customer-verified; the RFC's "Verification gap" is closed.
