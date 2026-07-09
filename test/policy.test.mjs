// Policy structure tests for bclaw-deploy-policy.json.
//
// These tests guard the deployer IAM policy against regressions of
// CloudFormation deployment failures caused by missing/incorrect permissions:
//   1. EFS mount-target actions are tag-conditioned alongside other EFS
//      manage actions (mount-target actions evaluate against the file-system
//      resource type, which IS taggable).
//   2. ECS (and EFS) service-linked roles must be creatable by the deployer
//      when they don't already exist in the account.
//
// See references/iam-and-template-lessons.md for the full diagnosis.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.resolve(__dirname, "..", "template", "bclaw-deploy-policy.json");

/** Load and parse the deployer policy JSON. */
async function loadPolicy() {
  const raw = await fs.readFile(POLICY, "utf8");
  return JSON.parse(raw);
}

/** Find a statement by Sid (returns undefined if not found). */
function findStmt(statements, sid) {
  return statements.find((s) => s.Sid === sid);
}

test("policy is valid JSON with a Statement array", async () => {
  const policy = await loadPolicy();
  assert.ok(Array.isArray(policy.Statement), "Statement must be an array");
  assert.ok(policy.Statement.length > 0, "Statement must not be empty");
});

// ── EFS mount targets: tag-conditioned with other EFS manage actions ────────

test("EFSManage is a single tag-conditioned statement covering all EFS manage actions", async () => {
  const policy = await loadPolicy();
  const stmt = findStmt(policy.Statement, "EFSManage");
  assert.ok(stmt, "EFSManage statement must exist");
  assert.equal(stmt.Effect, "Allow");

  const actions = stmt.Action;

  // Must cover taggable EFS resources: file system delete, access points, tags.
  for (const required of [
    "elasticfilesystem:DeleteFileSystem",
    "elasticfilesystem:CreateAccessPoint",
    "elasticfilesystem:DeleteAccessPoint",
    "elasticfilesystem:CreateTags",
    "elasticfilesystem:TagResource",
  ]) {
    assert.ok(actions.includes(required), `EFSManage missing ${required}`);
  }

  // Must also cover mount-target actions — these evaluate against the
  // file-system resource type (which IS taggable), so the tag condition
  // scopes them to the claw's own file system.
  for (const required of [
    "elasticfilesystem:CreateMountTarget",
    "elasticfilesystem:DeleteMountTarget",
    "elasticfilesystem:DescribeMountTargets",
  ]) {
    assert.ok(
      actions.includes(required),
      `EFSManage must include ${required} (mount-target actions evaluate against the file-system resource type)`,
    );
  }

  // Must carry the tag condition.
  assert.ok(
    stmt.Condition?.StringEquals?.["aws:ResourceTag/Name"],
    "EFSManage must be tag-conditioned on aws:ResourceTag/Name",
  );
});

test("EFSMountTargets statement does not exist (mount targets are in EFSManage)", async () => {
  const policy = await loadPolicy();
  const stmt = findStmt(policy.Statement, "EFSMountTargets");
  assert.equal(
    stmt,
    undefined,
    "EFSMountTargets should not exist — mount-target actions belong in the tag-conditioned EFSManage statement",
  );
});

test("EFSManageTagged statement does not exist (superseded by EFSManage)", async () => {
  const policy = await loadPolicy();
  const stmt = findStmt(policy.Statement, "EFSManageTagged");
  assert.equal(
    stmt,
    undefined,
    "EFSManageTagged should not exist — the unified statement is EFSManage",
  );
});

// ── Fix 2: service-linked role creation permission ──────────────────────────

test("ServiceLinkedRoles statement grants iam:CreateServiceLinkedRole for EFS, ECS, and ECS autoscaling", async () => {
  const policy = await loadPolicy();
  const stmt = findStmt(policy.Statement, "ServiceLinkedRoles");
  assert.ok(stmt, "ServiceLinkedRoles statement must exist");
  assert.equal(stmt.Effect, "Allow");
  assert.equal(stmt.Action, "iam:CreateServiceLinkedRole");

  const resources = stmt.Resource;
  assert.ok(Array.isArray(resources), "ServiceLinkedRoles Resource must be an array of SLR ARNs");

  // The three service-linked roles the deploy needs.
  const expectedSlrs = [
    "AWSServiceRoleForAmazonElasticFileSystem",
    "AWSServiceRoleForECS",
    "AWSServiceRoleForApplicationAutoScaling_ECSService",
  ];
  for (const slr of expectedSlrs) {
    const match = resources.find((r) => r.includes(slr));
    assert.ok(match, `ServiceLinkedRoles must scope to ${slr} (got: ${resources.join(", ")})`);
  }

  // The condition must scope via iam:AWSServiceName to the matching service principals.
  const svcNames = stmt.Condition?.StringLike?.["iam:AWSServiceName"];
  assert.ok(Array.isArray(svcNames), "ServiceLinkedRoles must use iam:AWSServiceName condition");
  for (const principal of [
    "elasticfilesystem.amazonaws.com",
    "ecs.amazonaws.com",
    "ecs.application-autoscaling.com",
  ]) {
    assert.ok(svcNames.includes(principal), `ServiceLinkedRoles condition missing ${principal}`);
  }
});

test("the ECS service-linked role is named AWSServiceRoleForECS, not AWSServiceRoleForAmazonECS", async () => {
  // Guards against the naming-inconsistency gotcha: the ECS SLR drops the
  // "Amazon" prefix while the EFS SLR keeps it.
  const policy = await loadPolicy();
  const stmt = findStmt(policy.Statement, "ServiceLinkedRoles");
  const ecsArn = stmt.Resource.find((r) => r.includes("ecs.amazonaws.com"));
  assert.ok(
    ecsArn.includes("AWSServiceRoleForECS"),
    `ECS SLR must be AWSServiceRoleForECS (got: ${ecsArn})`,
  );
  assert.ok(
    !ecsArn.includes("AWSServiceRoleForAmazonECS"),
    `ECS SLR must NOT be AWSServiceRoleForAmazonECS (got: ${ecsArn})`,
  );
});
