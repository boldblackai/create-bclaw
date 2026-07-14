# Scope ECS write + EC2 network create permissions in cfn-exec policy

**Date:** 2026-07-14
**Status:** Done

Related RFC: none (journal-only cycle).

## Goal

Tighten two areas of `template/bclaw-cfn-exec-policy.json`:

1. **`ECSWrite`** — the `Resource` array ends with `"*"`, which supersedes the
   three specific ARNs above it, so `ecs:DeleteCluster` (and every other action
   in the statement) is granted on **any** ECS resource in the account. The
   AWS service-authorization reference shows 6 of the 7 actions support
   resource-level perms; only `DeregisterTaskDefinition` requires `*`. Fix:
   split into `ECSWriteScoped` (the 6 actions on the existing
   `cluster/bclaw` / `service/bclaw/*` / `task-definition/bclaw:*` ARNs, **no
   trailing `*`**) + `ECSWriteGlobal` (`DeregisterTaskDefinition` alone on `*`).

2. **`EC2NetworkingCreate`** — all 6 creates + a broad `CreateTags` on `*`
   with no condition. The broad `CreateTags` is the EC2 analog of the
   deployer-side H1 finding (tag anything → defeat tag-scoped destructive
   perms). Goal: close the broad `CreateTags` and scope the network creates
   where feasible.

Verification: fresh CREATE (tear down the live `otacon` stack, redeploy from
scratch with `--role-arn`) — a no-op UPDATE does not exercise
`CreateCluster`/`CreateService`/`RegisterTaskDefinition`/`CreateVpc` under the
new scope (per the cfn-service-role RFC: "UPDATE-only probes are insufficient").

## Entries

### ECS split is clean (CreateCluster succeeds under the scoped statement)

On every fresh CREATE, `CreateCluster` (and `RegisterTaskDefinition`) succeeded
under `ECSWriteScoped` (resource ARNs, no trailing `*`). The ECS split is
proven; `ECSWriteGlobal` carries only `DeregisterTaskDefinition` (no
resource-level support). No ECS action needed a trailing `*`.

### VPC-child creates cannot be tag-scoped (both RequestTag and ResourceTag fail)

Scoping the EC2 network creates by `Name` tag turned out **partially
infeasible**. Two fresh CREATEs established this:

- **Deploy 1** — single `aws:RequestTag/Name=otacon*` over all 6 creates:
  `CreateVpc` / `CreateInternetGateway` (top-level) **succeeded**, but
  `CreateSubnet` / `CreateRouteTable` / `CreateSecurityGroup` **failed**. Their
  errors named the **parent VPC** as the resource (`...:vpc/vpc-...`).
- **Deploy 2** — moved the 3 child creates to
  `aws:ResourceTag/Name=otacon*`: they **failed again**, this time naming the
  **new resource** (`...:subnet/*`, `...:security-group/*`, `...:route-table/*`).

The evaluated resource flips with the condition key, so neither key reliably
matches for VPC-child creates. Top-level creates (`CreateVpc` /
`CreateInternetGateway`, and the existing `CreateVolume`) authorize against
the new resource with tags in the request, so `RequestTag` works for them.

Resolution: scope what's scopable, leave the rest unscoped.

- `CreateVpc`, `CreateInternetGateway`, `CreateTags` →
  `aws:RequestTag/Name=otacon*` (new resource; tags in request). `CreateTags`
  lives here because tagging a freshly-created resource evaluates against a
  tag-less resource, so only `RequestTag` can match — and this is also what
  **closes the broad `CreateTags`**: `CreateTags` now exists in exactly one
  statement and is tag-gated (also removed from `EC2LaunchTemplateManage`,
  where it had been a second unscoped grant).
- `CreateSubnet`, `CreateRouteTable`, `CreateSecurityGroup` → unscoped
  (`Resource: "*"`, no condition). Tag-scoping them is infeasible in this CFN
  flow. Low blast radius on the CFN-assumed role (they create a named resource
  in a VPC the same role just created); the meaningful privesc-adjacent perm
  (`CreateTags` on `*`) is closed regardless.

Re-proven by a fresh CREATE after this split (VPC/IGW/Cluster all create).

> Decoding the encoded authorization messages would have given ground truth,
> but the deployer identity intentionally lacks `sts:DecodeAuthorizationMessage`
> (the cfn-service-role RFC's L4 follow-up), so the diagnosis rests on two
> empirical CREATE failures plus the resource ARN in each error.
