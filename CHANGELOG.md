# Changelog

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
