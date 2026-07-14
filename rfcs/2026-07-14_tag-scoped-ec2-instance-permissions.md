# Tag-scoped EC2 instance-management permissions in the deployer policy

**Date:** 2026-07-14
**Status:** Proposed

## Goal

Introduce **host-debug instance operations** — `ec2:GetConsoleOutput` (boot /
UserData logs) and `ec2:TerminateInstances` (manual force-replace) — into the
deployer policy, scoped to the claw's container instances via
`aws:ResourceTag/ClawName`. These are **net-new capabilities**: today the
deployer policy grants *neither* action, so an operator currently cannot
retrieve a stuck instance's console output or manually kill a wedged instance
at all. The scoping keeps that new capability to the claw's own instances — no
account-wide EC2 instance control.

This closes the instance-management callout that the
[2026-07-13 ECS-on-EC2 RFC][parent] left open, and supersedes [issue #6][i6],
which was closed obsolete once instance tagging was confirmed healthy.

[parent]: ./2026-07-13_ecs-ec2-ebs-persistent-storage.md
[i6]: https://github.com/boldblackai/create-bclaw/issues/6

## Motivation

### The parent RFC deferred deployer-side instance management

The ECS-on-EC2 RFC moved the claw onto a single EC2 container instance launched
by an Auto Scaling Group. Its original *Technical Details* called for scoping
deployer EC2 perms to the claw's tag
(`aws:ResourceTag/Name: <name>-*`) — but that scoping **never shipped for
instance-level ops**. What actually landed:

- `ec2:RunInstances` is present, at `Resource: *` with **no condition**
  (`EC2LaunchTemplateManage`).
- `ec2:GetConsoleOutput` and `ec2:TerminateInstances` are **absent from the
  deployer policy entirely** (confirmed in both `template/bclaw-deploy-policy.json`
  and the live `/alt/integration/otacon-deploy-policy.json`).

So the deployer can neither read a container instance's console nor terminate
one. The implementation notes of the parent RFC overstate this: they claim the
policy "added `ec2:RunInstances`/`TerminateInstances`" when only `RunInstances`
shipped. *(That discrepancy is corrected in the parent RFC in the same change
that proposes this one.)*

### Two concrete operator needs are currently unfulfillable

1. **UserData / boot debugging.** When the container instance fails to register
   to ECS — a UserData format error, an EBS-attach race, a mount failure — there
   is no ECS task to `ExecuteCommand` into, and no running agent to SSM into.
   The only diagnostic is the EC2 **console output** (`ec2:GetConsoleOutput`),
   which captures the boot/UserData log. The deployer cannot retrieve it today.
2. **Manual instance replacement.** An instance can be wedged-but-passing-health
   (ECS agent stuck, task zombie, attached volume in a bad state) before the ASG
   health check trips. The operator needs to force a replacement via
   `ec2:TerminateInstances` — the ASG then launches a successor that reattaches
   the retained EBS volume. The deployer cannot do this today.

### Tag-scoping is the data-path contract, not just hygiene

The container instance's `ec2:AttachVolume` (in `ContainerInstanceRole`) is
already scoped by `aws:ResourceTag/ClawName` — see the parent RFC's Revision
block ("instance and volume have different `Name` values, so a per-resource
`Name` condition can't match both sides of an `AttachVolume` request"). That
scoping is **only sound if instances reliably carry the `ClawName` tag**,
because an untagged instance would be denied the boot-time volume attach and
`/data` would never mount — bringing back exactly the WAL-on-NFS corruption the
parent RFC exists to fix.

Instance tagging is confirmed healthy on the live `otacon` stack today
(`i-05666b279f750b8c4` carries `Name`/`ClawName` plus the propagated
`aws:cloudformation:*` / `aws:autoscaling:*` tags). Gating operator-facing
instance perms on the same `ClawName` tag *reinforces* that contract rather than
introducing a new dependency on it: the same tag key that the data path already
requires is also the gate for management access.

## Technical Details

### The central question: does `Allow` + `ec2:ResourceTag` match for `TerminateInstances`?

Issue #6 asserted that "`ec2:TerminateInstances` evaluates against
`arn:...:instance/*` (the wildcard), not the concrete instance ARN, so even with
tags present an *Allow* with a tag condition may not match — a Deny-based
approach … is the robust pattern." **This is overstated**, and resolving it is
the load-bearing task of the integration cycle.

Doc-based prior (to confirm empirically): **`Allow` + `ec2:ResourceTag` is the
supported, canonical pattern for instance start/stop/reboot/terminate.** AWS's
own example [*Allows starting or stopping EC2 instances a user has
tagged*][ec2-tag-owner] is precisely `Effect: Allow`, `Resource:
arn:aws:ec2:*:*:instance/*`, `Condition: ec2:ResourceTag/...`, applied to
stop/start. Resource-level permissions with tag conditions were extended to the
management plane (start/stop/reboot/terminate) in the [resource-level-permissions
release][rlp]; `TerminateInstances` is in the supported set.

[ec2-tag-owner]: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_examples_ec2_tag-owner.html
[rlp]: https://aws.amazon.com/blogs/security/resource-level-permissions-for-ec2-controlling-management-access-on-specific-instances/

Issue #6's "need Deny-based" conflates two distinct patterns:

- **(a) `Allow` + `ResourceTag`** — the supported path when you are *granting*
  scoped access. This is what we want.
- **(b) `Deny` + `ResourceTag`** — used when you must carve an exception out of
  a *broader existing `Allow`* (e.g. the [*limit terminating to an IP
  range*][ec2-terminate-ip] example denies terminate unless the caller is in an
  IP CIDR — something `ResourceTag` cannot express).

[ec2-terminate-ip]: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_examples_ec2_terminate-ip.html

We have no broader `Allow ec2:TerminateInstances on *` to carve out of — we are
*introducing* the permission scoped. So **pattern (a) is both right and
sufficient**; pattern (b) only applies if we first grant unscoped then deny,
which is strictly worse. The integration cycle confirms (a) empirically (policy
simulator or a live tagged-vs-untagged test); `Deny`-based is documented below
as *optional* defense-in-depth, not required.

### Proposed statement

A single new statement in the deployer policy, scoped to the claw's instances:

```json
{
  "Sid": "EC2InstanceOps",
  "Effect": "Allow",
  "Action": [
    "ec2:GetConsoleOutput",
    "ec2:TerminateInstances"
  ],
  "Resource": "arn:aws:ec2:*:*:instance/*",
  "Condition": {
    "StringEquals": {
      "aws:ResourceTag/ClawName": "bclaw"
    }
  }
}
```

This mirrors the existing `EC2DataVolumeManage` statement (which gates
`DeleteVolume`/`DetachVolume` on `aws:ResourceTag/Name: bclaw-data`) — same
shape, different resource type and tag key. The `ClawName` key is chosen over
`Name` deliberately: `Name` differs between the instance (`<name>-instance`)
and the volume (`<name>-data`/`<name>-root`), while `ClawName` is the shared key
that already gates `AttachVolume` — keeping one consistent gate across the whole
instance lifecycle.

`GetConsoleOutput` is read-only; the same `ClawName` condition keeps it to the
claw's instances and away from co-tenant instances in the account (e.g. the
`remind-api-production` instances that live in the same account and carry a
different `ClawName`/no `ClawName`).

### Sub-decision: what to do with the unscoped `ec2:RunInstances`

`ec2:RunInstances` currently lives in `EC2LaunchTemplateManage` at
`Resource: *`, no condition. On the normal deploy path the deployer **never
calls `RunInstances`** — CloudFormation creates the `AWS::EC2::LaunchTemplate`
(needs only `CreateLaunchTemplate*`) and the `AWS::AutoScaling::AutoScalingGroup`,
and the **ASG's service-linked role** (`AWSServiceRoleForAutoScaling`) is the
principal that calls `RunInstances` to launch instances, not the deployer. So
the deployer's `ec2:RunInstances` is exercised only for *manual* operator use
(launching a scratch/diagnostic instance). Two options for the integration cycle:

- **(A) Drop `ec2:RunInstances` from the deployer policy entirely.** Tightest —
  real launches go through the ASG SLR; a scratch-launch need can use a separate
  escalated path. **(Prior.)**
- **(B) Keep it but scope with `aws:RequestTag/ClawName`** so any instance the
  deployer launches must carry the tag — mirrors `EC2DataVolumeCreate`'s
  `aws:RequestTag/Name` pattern. Retains the manual-launch capability at the
  cost of a tag-forced condition.

This is a secondary decision; either is acceptable. Flagged for the cycle.

### Policy-size note

The managed-policy character limit (6144) was already a binding constraint on
the parent RFC (it compacted statements to fit). Adding one small statement is
within budget; if tight on re-attach, the new `EC2InstanceOps` can merge into
the existing instance-adjacent statement, or `ReadOnlyDescribe` can shed an
action. No structural change expected.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| **Deny-based** (`Allow ec2:TerminateInstances on *` + `Deny … unless ec2:ResourceTag/ClawName`) | Rejected as primary — only meaningful when carving out of a *broader* Allow; re-introduces the account-wide grant this RFC removes and is more complex. Optional as defense-in-depth (see below). |
| **Grant unscoped** (`Resource: *`, no condition) | Rejected — defeats least-privilege; the whole point is the claw must not touch co-tenant instances in the same account. |
| **Rely on ASG / CloudWatch only (no manual terminate)** | Rejected — the operator needs a manual kill path for wedged-but-healthy instances that pass EC2/ECS health checks. |
| **Scope on `aws:ResourceTag/Name` instead of `ClawName`** | Rejected — `Name` differs across the instance/volume/root resources, so it can't be the single gate; `ClawName` is the shared key the data path already uses. |

### Optional defense-in-depth (not in v1)

If, after the integration cycle confirms (a), we want belt-and-suspenders, we
can *additionally* deny instance ops on resources *lacking* the tag:

```json
{
  "Sid": "DenyInstanceOpsWithoutClawTag",
  "Effect": "Deny",
  "Action": ["ec2:GetConsoleOutput", "ec2:TerminateInstances"],
  "Resource": "arn:aws:ec2:*:*:instance/*",
  "Condition": { "Null": { "aws:ResourceTag/ClawName": "true" } }
}
```

This is redundant with the `Allow` + `ResourceTag` statement above (an untagged
instance already fails the `Allow`), so it is **not** proposed for v1 —
documented only to record that the Deny pattern was considered and is available
if a future broader grant makes it load-bearing.

## Migration Notes

- **Integration cycle required** per repo workflow. Prototype in
  `/alt/integration`: add the scoped `EC2InstanceOps` statement to
  `otacon-deploy-policy.json`, re-attach the managed policy, and verify:
  1. `aws ec2 get-console-output --instance-id <otacon instance>` succeeds;
     the same call against a non-claw instance (e.g. a `remind-api-production`
     instance) is denied.
  2. `ec2:TerminateInstances` matches under `Allow` + `ResourceTag/ClawName`
     on the tagged instance (policy simulator or a controlled live test), and is
     denied on an untagged / differently-tagged instance. **This is the
     empirical confirmation of the central question above.**
  3. Resolve the `RunInstances` sub-decision (A drop vs B scope).
- **Golden test** (`test/golden.test.mjs`) is unaffected in *mechanism* — the
  template policy still flows through the `bclaw`-only rename; no new immutable
  tokens are introduced (the `ClawName` tag key already exists). The check
  remains `template/`↔generated byte-for-byte.
- **Port back**: edit `template/bclaw-deploy-policy.json`, then reconcile with
  `diff -rq /workspace/template /alt/integration
  --exclude=.git --exclude=.agents/skills --exclude=node_modules --exclude=dist`
  per the repo workflow.

## Implementation Checklist

- [ ] Integration cycle: add scoped `EC2InstanceOps` to
      `/alt/integration/otacon-deploy-policy.json`; re-attach managed policy.
- [ ] Empirically confirm `Allow` + `aws:ResourceTag/ClawName` matches for
      `GetConsoleOutput` and `TerminateInstances` (simulator or live
      tagged-vs-untagged test) on the `otacon` instance; confirm denial on a
      co-tenant instance.
- [ ] Decide `RunInstances`: drop (A) vs scope-with-`RequestTag/ClawName` (B);
      implement.
- [ ] Update `manage-bclaw` skill to document the new ops where relevant
      (`get-console-output` for boot/UserData debugging; `terminate-instances`
      for manual force-replace). Keep shipped content factual and present-tense.
- [ ] Port back into `template/bclaw-deploy-policy.json`.
- [ ] `pnpm test` (golden), `pnpm lint`, `pnpm exec tsc --noEmit`.
- [ ] Reconcile `diff -rq /workspace/template /alt/integration …`.
- [ ] Move this RFC to `Implemented`; replace this checklist with
      implementation notes (including the empirically-resolved Allow-vs-Deny
      answer and the RunInstances decision).

## Open questions

1. **`Allow` vs `Deny` for `TerminateInstances`.** Prior: `Allow` +
   `ec2:ResourceTag` works (AWS canonical `ec2-tag-owner` example + resource-level
   release). Confirm empirically in the cycle. *(Expected resolution: Allow works;
   Deny deferred as optional hardening.)*
2. **`RunInstances` fate.** Drop (A) or scope-with-`RequestTag` (B)? Prior: drop
   (A) — the ASG SLR handles real launches; the deployer's `RunInstances` is
   manual-scratch only. Resolve in the cycle.
