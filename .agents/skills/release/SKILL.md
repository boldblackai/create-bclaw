---
name: release
description: Automate releasing the @boldblackai/create-bclaw npm package. Use this skill whenever the user wants to cut a release, publish a new version, bump the version, tag a release, update the CHANGELOG, or run npm publish. Triggers on phrases like "release version X", "cut a release", "publish", "bump to X.X.X", "tag this release", "release the project", or any combination of version bumping + publishing intent. Always use this skill for release work — don't attempt ad-hoc release steps without it.
---

# Release Skill for `@boldblackai/create-bclaw`

Automates the full release pipeline: pre-flight checks → version bump → CHANGELOG → verify → build → open release PR → (maintainer merges) → CI auto-tags, publishes to npm (OIDC), creates GitHub release.

> **npm publishing is fully automated via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC).** The agent never touches npm credentials, pushes tags, or creates GitHub releases. It only opens a release PR; merging that PR triggers `tag-on-merge.yml`, which handles everything: tag, npm publish (with provenance attestations), and GitHub release — all in one workflow.
>
> **Release model:** The trust boundary is "can merge a PR to main" = "can release." The agent has zero upstream write access — it opens the PR from its fork (BoldBlackBot); the maintainer's squash-merge triggers everything.
>
> **Prerequisite (one-time, manual on npmjs.com):** Configure the trusted publisher for `@boldblackai/create-bclaw` under Settings → Trusted Publisher → GitHub Actions: org=`boldblackai`, repo=`create-bclaw`, workflow filename=`tag-on-merge.yml`. Then under Settings → Publishing access, select "Require two-factor authentication and disallow tokens" (recommended) — OIDC publishes are unaffected by this setting.

## Step 1: Pre-flight checks (abort on failure)

**Ensure working from latest main** — Fetch latest and verify local main matches remote:

```bash
git fetch origin main
git checkout main
git pull --ff-only origin main
```

If `git pull --ff-only` fails (local main has diverged), inform the user and abort.

**Clean working state** — Run `git status`. If there are uncommitted changes beyond what you're about to create (`package.json` + `CHANGELOG.md`), warn the user and ask whether to proceed.

**README is up to date** — Read `README.md` and the commits since the last tag (collected in Step 3). Check whether any commit introduces new CLI flags/options (`--region`, `--force`, etc.), changes the name validation rules, alters generator behavior, or changes what the generated claw contains — and isn't already reflected in `README.md`. If gaps are found, list them and ask the user to update `README.md` before continuing:

> "Aborting: README.md appears out of date. The following changes may need documentation: `<list>`. Update README.md and re-run the release."

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

Edit the `version` field directly in `package.json`. Do not use `npm version` — it creates git commits and tags automatically and would interfere with the release workflow.

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

## Step 8: Create release branch and commit

Create a release branch from main and commit all release changes:

```bash
git checkout -b release/v<version>
git add package.json CHANGELOG.md
git commit -m "release v<version>"
```

## Step 9: Push branch and open release PR

Ensure a fork remote exists (for the agent's bot account):

```bash
git remote add fork https://github.com/BoldBlackBot/create-bclaw.git 2>/dev/null || true
```

Push the release branch:

```bash
git push -u fork release/v<version>
```

Open the PR — the squash merge commit message (`release v<version>`) is the sentinel that gates `tag-on-merge.yml`:

```bash
gh pr create \
  --repo boldblackai/create-bclaw \
  --head BoldBlackBot:release/v<version> \
  --base main \
  --title "release v<version>" \
  --body "Release v<version>.

See CHANGELOG.md for details.

Merging this PR will automatically:
1. Push the \`v<version>\` tag
2. Publish to npm via OIDC (with provenance)
3. Create the GitHub release" \
```

## Step 10: Wait for maintainer to merge the PR

**STOP HERE.** The skill cannot proceed until the PR is merged. Tell the user:

> "Release PR #N is up: *URL*. Review and merge it, then tell me to continue."

Do not proceed to Step 11 until the user confirms the PR has been merged.

## Step 11: Monitor the automated release pipeline (read-only)

After the PR is squash-merged, the merge commit (`release v<version> (#N)`) triggers `tag-on-merge.yml` on push to main. It pushes the `v<version>` tag, publishes to npm via OIDC, and creates the GitHub release — all in one workflow. All of this runs as CI — the agent only monitors, never acts.

> **The PR must be squash-merged** so the commit message starts with `release v`. If the merge method is changed, the sentinel won't match and the pipeline won't fire.

### 11a: Verify tag-on-merge ran (tag + npm + release)

```bash
gh run list --repo boldblackai/create-bclaw --workflow tag-on-merge.yml --limit 1
```

Confirm the workflow succeeded. If it failed, check logs:

```bash
gh run view <run-id> --repo boldblackai/create-bclaw --log-failed
```

Once the workflow succeeds, verify the package landed on npm **with provenance attestations**:

```bash
npm view @boldblackai/create-bclaw@<version> dist --json
```

Confirm the output includes an `attestations` field (not just `signatures`). If `attestations` is missing, the publish did not generate provenance — investigate before continuing.

## Final report

Tell the user:

- Version released
- The CHANGELOG entry added
- Release PR URL (merged)
- npm publish status (workflow green, provenance attestations confirmed)
- GitHub release URL
