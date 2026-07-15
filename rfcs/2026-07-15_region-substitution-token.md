# Region substitution token for scaffold-time `kms:ViaService`

**Date:** 2026-07-15
**Status:** Proposed

## Goal

Stop hardcoding `us-east-1` in the deployer IAM policy's `KMSUseKey` statement
by introducing `us-east-1` as a **second literal substitution token** (alongside
`bclaw`) that the generator collects at scaffold time and stamps into the
generated claw. A user running `npx @boldblackai/create-bclaw foo --region
us-west-2` gets a claw whose `foo-deploy-policy.json` reads
`"kms:ViaService": "ssm.us-west-2.amazonaws.com"` — so the deployer identity can
actually `kms:Encrypt`/`Decrypt` via SSM in that region, instead of hitting an
opaque `AccessDeniedException`.

Closes boldblackai/create-bclaw#10.

## Motivation

### The bug

`template/bclaw-deploy-policy.json` → `KMSUseKey` pins the region:

```json
{
  "Sid": "KMSUseKey",
  "Effect": "Allow",
  "Action": ["kms:Decrypt", "kms:Encrypt", "kms:ScheduleKeyDeletion"],
  "Resource": "*",
  "Condition": {
    "ForAnyValue:StringLike": { "kms:ResourceAliases": "alias/bclaw-ssm" },
    "StringEquals": { "kms:ViaService": "ssm.us-east-1.amazonaws.com" }
  }
}
```

The task `ExecutionRole` in `template.yaml` gets this right —
`"kms:ViaService": !Sub "ssm.${AWS::Region}.amazonaws.com"` — because it is a
CloudFormation resource and can use intrinsics. The **deployer** policy is a
static IAM JSON the user attaches by hand, so it cannot use `${AWS::Region}`,
and it is therefore pinned to `us-east-1`.

### Impact

The setup skill explicitly lets the user pick a region (Phase 1, step 1;
default `us-east-1` but configurable). A user deploying in `us-west-2`:

1. Attaches the shipped policy as-is (the skill never tells them to edit it for
   region).
2. During setup Phase 3 / the first task start, the deployer identity's
   `kms:Encrypt`/`Decrypt` calls arrive as `ssm.us-west-2.amazonaws.com` and are
   **denied** by the `StringEquals` condition.
3. Result: the SSM SecureStrings can't be created/read → an opaque
   `AccessDeniedException` mid-setup, with no hint that the region is the cause.

This makes the generator region-blind: it produces a claw that silently only
works in one region, while its own skills advertise region as a free choice.

### Why scaffold-time (not deploy-time)

`us-east-1` is the only `us-east-1`-bearing artifact that matters for the
failure, but a region token is a natural, symmetric extension of the generator's
existing identity — "literal token replace" — rather than a one-off patch on a
single policy line. The original scaffolder RFC even anticipates a second
literal token ("a second `org` token is a clean future add that does not change
the v1 architecture"). Treating `us-east-1` as that second token keeps the
transform uniform (one mechanism, applied to contents + path components), keeps
the golden test's structure (invariant 2 generalizes from one pair to many), and
has the side benefit of making the generated claw's other region-bearing files
default to the chosen region too (`.env.example`, the skills' region-default
prose, the `template.yaml` `AZ1` fallback), reducing deploy-time friction.

## Technical Details

### Rename model: a list of `(from, to)` pairs

Today the generator applies one literal replace: `bclaw` → `name`. This RFC
generalizes it to an **ordered list** of `(from, to)` token pairs:

```
[ ("bclaw", name), ("us-east-1", region) ]
```

applied to file contents **and** path components (and symlink target strings),
in `copyTree`/`copyFile`/the residual scan. The two tokens are disjoint
substrings — `us-east-1` contains no `bclaw` and vice versa — so application
order is irrelevant to correctness; `bclaw` is applied first to match the
existing implementation's shape.

`REGION_FROM = "us-east-1"` is the new constant, mirroring `RENAME_FROM =
"bclaw"`.

### CLI: collect the region at scaffold time

- **New flag:** `--region <region>`, added to `KNOWN_FLAGS`. Validated against
  `^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$` — admits every current AWS region,
  including AWS GovCloud (`us-gov-west-1`) and China (`cn-north-1`); the
  `[a-z]+` middle segment is permissive enough to admit future regions without a
  bump.
- **Default:** `us-east-1`.
- **Prompting:** unlike the name, the region has a safe default, so the prompt
  rules differ:
  - `--region` given → validate and use it (no prompt).
  - Interactive (TTY), no flag → `askRegion()` shows the default and Enter
    accepts it.
  - Non-interactive (non-TTY), no flag → **use the default silently** (do not
    fail, as `name` does). This keeps `npx @boldblackai/create-bclaw foo`
    working unattended in CI and respects that the skills re-confirm region at
    deploy time anyway.
- **Help text** gains a `--region` line.

### Generator: two-pass replace + a guarded residual assertion

`GenerateOptions` gains `region: string`. `copyFile`/path-component renaming
becomes a chained `.split("bclaw").join(name).split("us-east-1").join(region)`.

The hard post-copy residual assertion gains a second pass for `us-east-1`,
**guarded by `region !== "us-east-1"`** — the exact mirror of the existing
`!name.includes("bclaw")` guard. This is load-bearing: when the region *is*
`us-east-1`, the rename is a no-op, so `us-east-1` legitimately survives
everywhere and must not trip the assertion. The guard is what preserves
invariant 1 (`create-bclaw bclaw` with the default region == `template/`
byte-for-byte).

### Golden test: generalize invariant 2 to many tokens

`test/golden.test.mjs` is the correctness proof. Three changes:

1. **`renameTree` takes a list of pairs**, not one `(from, to)`:
   `renameTree(tree, [["bclaw", "foo"], ["us-east-1", "us-west-2"]])`.
2. **Invariant 2 extended:** `create-bclaw foo --region us-west-2` == (`create-bclaw bclaw`
   output renamed `bclaw→foo` **and** `us-east-1→us-west-2`). This proves the
   region rename is complete and is the *only* delta beyond the name rename.
3. **New residual invariant:** zero `us-east-1` in the
   `foo --region us-west-2` output.

Invariant 1 is unchanged in *mechanism* (`create-bclaw bclaw`, default region →
no-op on both tokens → byte-identical to `template/`). The `generate()` direct
test gains a `region` arg; CLI smoke tests add `--region` acceptance, invalid
region rejection, and `--region` membership in `KNOWN_FLAGS`.

### Template: no hand-edits required

The substitution is automatic and global. The 11 `us-east-1` sites under
`template/` are all legitimate, lowercase, and become better, not worse:

| Site | After `us-east-1→<region>` |
| --- | --- |
| `bclaw-deploy-policy.json` `KMSUseKey` `kms:ViaService` | **The bug fix** — `ssm.<region>.amazonaws.com` |
| `template.yaml` `AZ1` `Default: us-east-1a` | `<region>a` — a strictly better fallback (the setup skill probes and overrides this anyway; `<region>a` is a more correct default than the literal `us-east-1a`) |
| `.env.example` `AWS_REGION=us-east-1` | `AWS_REGION=<region>` — the generated `.env` stub matches the chosen region |
| `README.md`, `AGENTS.md`, the three skills' region-default prose | Default prose reflects the chosen region |

None of these are problematic overlaps; none require special handling. (A
`grep -rn us-east-1 template/` is the audit the implementation must run to
confirm no *unexpected* site survives the rename — it should be exactly the
sites above.)

## Edge cases & risks

- **A claw literally named `us-east-1`.** The name regex `^[a-zA-Z]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`
  admits it (`us-east-1` matches), but the region pass would corrupt it
  (`us-east-1` → `<region>` inside the name). Guard: reject at validation any
  name that `includes("us-east-1")`, mirroring the spirit of the existing
  `!name.includes("bclaw")` guard. (A name containing the region token is
  pathological and rejecting it is the safe choice; an alias test documents the
  rejection.)
- **Invariant 1 / the no-op case.** `create-bclaw bclaw` with the default region
  (`us-east-1`) must remain byte-identical to `template/`. Both residual
  assertions are guarded out in that case, so it holds. The test suite must
  confirm this.
- **Region regex maintenance.** New AWS regions appear occasionally; the regex's
  `[a-z]+` middle segment is permissive enough that a new region like
  `eu-central-2` validates without a bump. No per-region maintenance is
  anticipated.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| **Scaffold-time region substitution (this RFC)** | **Chosen** — uniform with the existing literal-token identity; fixes the policy at the source so the on-disk file is always correct; the issue author's recommended fix. |
| **Drop the `kms:ViaService` condition** | Rejected — loosens the policy and creates an asymmetry with the task `ExecutionRole` (which keeps `ViaService`); loses the "KMS use only via SSM" belt-and-suspenders, leaving `kms:ResourceAliases` as the sole gate. `kms:ViaService` is a real defense (it binds KMS use to the SSM service principal); dropping it is a security regression, not just a simplification. |
| **Setup skill rewrites the region into the policy** before attach | Rejected — the policy file on disk stays wrong, so any re-attach / re-onboarding re-breaks; the fix is not durable. Also scatters region logic across scaffold + skill instead of one place. |
| **Wildcard the region** (`ssm.*.amazonaws.com`) | Rejected — `kms:ViaService` values are of the form `service.region.amazonaws.com`; wildcard support in the region segment is undocumented/unreliable. Not a robust fix. |
| **Status quo** | Rejected — the generator advertises region choice via its skills while shipping a policy that breaks in any non-`us-east-1` region. |

## Migration Notes

- **Integration cycle required** per repo workflow. Prototype in
  `/alt/integration`:
  1. Regenerate `/alt/integration` from the patched generator with a non-
     `us-east-1` region (e.g. `us-west-2`) and confirm the on-disk
     `<name>-deploy-policy.json` reads `ssm.us-west-2.amazonaws.com`.
  2. Re-onboard the deployer identity with that policy and run a live deploy
     through setup — confirm the deployer's `kms:Encrypt`/`Decrypt` via SSM
     succeeds (Phase 3 secret writes + Phase 4 task start decrypt them).
  3. Keep the existing `us-east-1` live test working too (regenerate with
     default region, confirm a deploy).
- **Journal:** record issues in
  `/workspace/references/integrations/2026-07-15_region-substitution.md`.
- **Port-back:** no template hand-edits are expected (substitution is automatic),
  but run `grep -rn us-east-1 template/` to audit the surviving sites, then
  reconcile with `diff -rq /workspace/template /alt/integration
  --exclude=.git --exclude=.agents/skills --exclude=node_modules --exclude=dist`.
  Any deviation that is *not* an expected region-bearing file is a missed item.
- **Existing deployments:** unaffected. A claw already generated with
  `us-east-1` keeps its `us-east-1` policy and continues to work in `us-east-1`;
  the generator only governs *new* scaffolds. Re-generating into a new region is
  a fresh scaffold (EBS data does not move cross-region — out of scope).
- **CLI contract:** `npx @boldblackai/create-bclaw <name>` remains backward-
  compatible — `--region` is optional with a `us-east-1` default.

## Implementation Checklist

- [x] Write this RFC (status `Proposed`).
- [x] Golden test (RED→GREEN): generalized `renameTree` to a list of pairs;
      extended invariant 2 to `foo --region us-west-2`; added the
      zero-residual-`us-east-1` invariant (3b); extended the `generate()` direct
      test and CLI smoke tests (`--region` accepted / rejected, `KNOWN_FLAGS`
      membership, the `us-east-1`-name rejection).
- [x] `src/cli.ts`: added `--region`, the region regex, `askRegion()` (default
      `us-east-1`, silent default in non-TTY), help text; rejects a name
      containing `us-east-1`; threads `region` into `generate()`.
- [x] `src/generate.ts`: added `REGION_FROM`, `GenerateOptions.region`, the
      two-pass replace, and the guarded `us-east-1` residual assertion.
- [x] Audited `grep -rn us-east-1 template/` — only the 11 expected sites
      survive the rename (deployer policy `kms:ViaService`, `AZ1` default,
      `.env.example`, `README.md`, `AGENTS.md`, region-default prose in the
      three skills).
- [x] Updated `README.md` (CLI usage: `--region`).
- [x] `pnpm lint` + `pnpm exec tsc --noEmit` + `pnpm test` green (17/17).
- [ ] Integration cycle in `/alt/integration` with a non-`us-east-1` region;
      journal in `references/integrations/2026-07-15_region-substitution.md`.
- [ ] Port-back + `diff -rq` reconciliation + golden test.
- [ ] Close issue #10; move RFC to `Implemented` (checklist → implementation
      notes; update `AGENTS.md`/`README.md` for the new `--region` flag).
