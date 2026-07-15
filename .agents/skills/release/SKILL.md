---
name: release
description: Automate releasing the @boldblackai/create-bclaw npm package. Use this skill whenever the user wants to cut a release, publish a new version, bump the version, tag a release, update the CHANGELOG, or run npm publish. Triggers on phrases like "release version X", "cut a release", "publish", "bump to X.X.X", "tag this release", "release the project", or any combination of version bumping + publishing intent. Always use this skill for release work — don't attempt ad-hoc release steps without it.
---

# Release Skill for `@boldblackai/create-bclaw`

Automates the full release pipeline: pre-flight checks → version bump → CHANGELOG → verify → build → publish → tag → GitHub release.

> **Scope.** This repo is the `create-bclaw` generator (npm CLI + bundled `template/`). It has no Dockerfiles and no deploy guides, so this skill does **not** do image-tag bumps, Dockerfile dependency diffs, or upstream release-note aggregation — those belong to the `harness` release skill. The `template/` snapshot ships inside the published package, so the golden test (`pnpm test`) is the integrity gate for everything a consumer receives.

## Step 1: Pre-flight checks (abort on failure)

**Main bookmark is up to date** — Verify that the local `main` bookmark and `main@origin` point to the same commit. In jj, remote bookmarks use `<bookmark>@<remote>` syntax (not `origin/<bookmark>`). Run:

```bash
jj log -r "main" --no-graph -T 'commit_id ++ "\n"'
jj log -r "main@origin" --no-graph -T 'commit_id ++ "\n"'
```

If they differ, there are unpushed commits on `main`. Inform the user:

> "Aborting: local main is ahead of main@origin. Push your commits first with `jj git push`."

**Clean working state** — Run `jj status`. If there are uncommitted changes beyond what you're about to create (`package.json` + `CHANGELOG.md`), warn the user and ask whether to proceed.

**README is up to date** — Read `README.md` and the commits since the last tag (collected in Step 3). Check whether any commit introduces new CLI flags/options (`--region`, `--force`, etc.), changes the name validation rules, alters generator behavior, or changes what the generated claw contains — and isn't already reflected in `README.md`. If gaps are found, list them and ask the user to update `README.md` before continuing:

> "Aborting: README.md appears out of date. The following changes may need documentation: <list>. Update README.md and re-run the release."

## Step 2: Determine the new version

- If the user gave an explicit version, use it.
- Otherwise read `version` from `package.json` and infer a semantic bump from commits since the last tag:
  - **patch** (default) — bug fixes, docs, tooling, and new features (`feat:` commits)
  - **minor** — only on user request or commits that add new user-facing CLI flags/options or change generator output meaningfully
  - **major** — only on user request or explicit breaking-change commit messages

Tell the user what version you chose and why before continuing.

## Step 3: Get commits since last release

```bash
# Find the last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null)

# If a tag exists:
git log ${LAST_TAG}..HEAD --oneline

# If no previous tag (first release):
git log --oneline
```

Collect these as bullet points for the changelog: `- <short-hash> <message>`

## Step 4: Update CHANGELOG.md

Get today's date:

```bash
date +%Y-%m-%d
```

Based on the commits collected, write a 1–3 sentence prose summary of what changed (new CLI options, generator behavior changes, template updates). Since `template/` ships inside the published package, call out notable template changes in the summary. Then include the raw commit list beneath it.

**If CHANGELOG.md does not exist**, create it:

```markdown
# Changelog

## [<version>] - <YYYY-MM-DD>

### Summary
<1–3 sentence prose summary of what changed>

### Changes
- <hash> <message>
```

**If it already exists**, insert the new entry immediately after the `# Changelog` header line, before any existing entries.

## Step 5: Bump version in package.json

Edit the `version` field directly in `package.json`. Do not use `npm version` — it creates git commits automatically and would interfere with the jj workflow.

## Step 6: Verify locally (mirror CI)

Run every check CI runs, in the same order as `.github/workflows/ci.yml`. Stop and fix before continuing if any fails:

```bash
pnpm install --frozen-lockfile   # ensure deps match the lockfile
pnpm lint                        # oxlint .
pnpm format:check                # oxfmt --check .
actionlint                       # lint the GitHub Actions workflows
pnpm exec tsc --noEmit           # typecheck
pnpm test                        # tsc && node --test — the golden test is the correctness proof
```

## Step 7: Build

```bash
pnpm build   # tsc → dist/
```

Stop if this fails.

## Step 8: Commit and push the release

In jj, file changes are automatically snapshotted in the working-copy commit. Describe it and move to a new empty commit:

```bash
jj describe -m "release v<version>"
jj new
```

Advance the main bookmark to the release commit, then push:

```bash
jj bookmark set main -r @-
jj git push --bookmark main
```

## Step 9: Publish to npm

`npm publish` requires an OTP and cannot be automated. The package is scoped public (`@boldblackai/create-bclaw`, `publishConfig.access: public`). Tell the user:

> "Please run `npm publish` (with `--otp=<code>` if prompted for 2FA). Let me know when it succeeds and I'll continue."

Wait for the user to confirm success before proceeding to Step 10.

## Step 10: Create and push the tag

Create the tag locally pointing to the release commit (one behind `@`, the current empty working copy):

```bash
jj tag set v<version> -r @-
```

Push it to the remote (jj doesn't support pushing tags directly; use git):

```bash
git push --tags
```

## Step 11: Create GitHub release

Extract the changelog section for this version — everything from `## [<version>]` down to (but not including) the next `## [` entry.

```bash
gh release create v<version> \
  --repo boldblackai/create-bclaw \
  --title "v<version>" \
  --notes "<changelog-entry>"
```

## Step 12: Post-flight — verify CI succeeded

This repo's CI (`.github/workflows/ci.yml`) triggers on pushes to `main`; there is no separate release workflow. After pushing the release commit to `main`, poll the most recent run on `main`:

```bash
gh run list --repo boldblackai/create-bclaw --branch main --limit 1
```

Use the run ID to watch for completion:

```bash
gh run view <run-id> --repo boldblackai/create-bclaw
```

Check that **all jobs** show `✓` (success): Lint, Format check, actionlint, Typecheck, Golden test. If any job failed, run:

```bash
gh run rerun <run-id> --failed --repo boldblackai/create-bclaw
```

Then wait for it to complete and verify again before reporting success.

Only report the release as complete once the entire workflow is green.

## Final report

Tell the user:

- Version released
- The CHANGELOG entry added
- GitHub release URL (from `gh release create` stdout)
- CI status (all jobs green)
