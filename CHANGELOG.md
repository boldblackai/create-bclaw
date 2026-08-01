# Changelog

## [1.0.2] - 2026-08-01

### Summary

Secrets now come natively from AWS SSM. Generated claws bundle the [`hermes-aws-ssm-secret-source`](https://github.com/boldblackai/hermes-aws-ssm-secret-source) plugin, which resolves SecureString parameters under `/<name>/` into environment variables at gateway start using the ECS TaskRole — no `.env` file to manage, and rotating a value in SSM takes effect on the next restart with no redeploy. Configuration is mapped-only: only the parameters listed in `config.yaml` are fetched, and only `SecureString` types are accepted.

### Changes

- f7f697e feat: add trusted publishing release pipeline (#29)
- a877f26 Tighten aws_ssm IAM and migrate config to mapped-only plugin
- 20ed7cd Port back aws_ssm secret-source plugin design
- facbde4 Document corkboard integration-journal workflow in AGENTS.md
- f06ed75 Add RFC: on-boot materialization of _-prefixed SSM secrets into $HERMES_HOME/.env
- 80ed201 Merge pull request #20 from boldblackai/feat/mise-env-replace-direnv
- e3f50ff docs: redact AWS identifiers in RFCs (#23)
- 77df9c3 docs: require AWS ID redaction in RFCs, PRs, and comments (#22)
- 87bd2d2 docs: discard integration journal after port-back (#21)
- 41e96d5 rfc(mise-env): mark Implemented; record integration cycle
- 5b5e0d5 docs: note /alt/integration uses mise for aws access
- 96a97fe docs(template/skills): switch activation snippet to mise-only
- 4df96f0 docs(template): switch activation snippet to mise-only
- 9bfb184 feat(template): load .env via mise, drop direnv
- 6fbcb06 Merge pull request #19 from boldblackai/rfc/mise-env-replace-direnv
- 3a8504d rfc: replace direnv with mise native .env loading

## [1.0.1] - 2026-07-16

### Summary

Adds a new `--region` CLI option that substitutes the chosen AWS region into the generated claw (notably the deployer IAM policy's static `kms:ViaService`, which cannot use CloudFormation's `${AWS::Region}`), and now rejects names containing the literal region token `us-east-1` so they aren't corrupted by substitution. The bundled `template/` gains a `$HERMES_HOME` persistence rule in `SOUL.md`. Development tooling migrated from Biome to mise-managed oxlint + oxfmt and gained markdownlint-cli2, alongside a TypeScript bump to ^7.

### Changes

- 8b7844c update desc and url
- ef4bc5e template: add $HERMES_HOME persistence rule to SOUL.md (#17)
- 3c38810 Add release skill for @boldblackai/create-bclaw (#15)
- 67a98af feat: add markdownlint-cli2 for Markdown linting (P007) (#16)
- 13a443f Replace Biome with oxlint + oxfmt (mise tools) (#14)
- 394d449 Merge pull request #13 from boldblackai/fix/hardcoded-region-kms-policy
- 77ca3c7 rfc(region-substitution): mark Implemented
- 3a447b9 Port back template updates from integration
- 75d5ba0 Merge pull request #12 from boldblackai/housekeeping/nits
- 3cadf6a Restore jj ignore line
- f5abb3d fix(deployer-iam): substitute deploy region into KMS ViaService
- b0a437d bump typescript 6.0.3 -> ^7.0.2
- b37bcf5 rfc for regions substitution token
- 96155a7 chore: scope .gitignore to this repo's own artifacts
- 6d0027a chore: expand .gitignore with common ignore patterns
