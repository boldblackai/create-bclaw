// Golden test for @boldblackai/create-bclaw.
//
// The product IS "rename bclaw→<name> completely", so this test is the
// correctness proof (RFC §Verification). Three invariants:
//   1. create-bclaw bclaw  == template/  byte-for-byte (rename is a no-op when
//      name == bclaw; proves the copy is faithful).
//   2. create-bclaw foo    == (create-bclaw bclaw output with bclaw→foo applied
//      to contents AND path components; proves the rename is complete and is
//      the ONLY delta).
//   3. grep bclaw on the foo output == empty (the hard "no residual" assertion,
//      enforced independently).
//
// Region substitution (rfcs/2026-07-15_region-substitution-token.md) adds a
// second literal token, `us-east-1`→<region>, so invariants 2/3 generalize:
//   2b. create-bclaw foo --region us-west-2 == bclaw output renamed
//      [bclaw→foo, us-east-1→us-west-2].
//   3b. grep us-east-1 on the foo --region us-west-2 output == empty.
//
// Plus CLI smoke tests for name validation and the non-empty-target guard.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "../dist/generate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const TEMPLATE = path.join(ROOT, "template");

/** Run the compiled CLI with the given args inside cwd; resolve exit info. */
function run(args, cwd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr: `${stderr}\n[TIMEOUT after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on("close", () => clearTimeout(timer));
  });
}

/**
 * Read a directory tree (excluding .git) into an object { relPath: Buffer }.
 * relPath uses POSIX separators so it is stable across platforms.
 */
async function tree(dir) {
  const out = {};
  async function walk(d, rel = "") {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else out[r] = await fs.readFile(p);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Apply an ordered list of literal substring replaces to a tree's contents
 * AND path components. Each pair is `[from, to]`; the generator's two tokens
 * are `[["bclaw", name], ["us-east-1", region]]`.
 */
function renameTree(treeObj, pairs) {
  const out = {};
  for (const [rel, content] of Object.entries(treeObj)) {
    let newRel = rel;
    let text = content.toString("utf8");
    for (const [from, to] of pairs) {
      newRel = newRel
        .split("/")
        .map((s) => s.split(from).join(to))
        .join("/");
      text = text.split(from).join(to);
    }
    out[newRel] = Buffer.from(text, "utf8");
  }
  return out;
}

/**
 * Strip a trailing `.template` suffix from each basename. The bundled
 * `template/` ships `.gitignore.template` (npm packlist drops a literal
 * `.gitignore`); the generator strips the suffix on materialize, so this
 * normalizes on-disk template keys to match generated output keys.
 */
function stripTemplateKeys(treeObj) {
  const out = {};
  for (const [rel, content] of Object.entries(treeObj)) {
    const parts = rel.split("/");
    const last = parts.length - 1;
    if (parts[last].endsWith(".template")) {
      parts[last] = parts[last].slice(0, -".template".length);
    }
    out[parts.join("/")] = content;
  }
  return out;
}

/** Find any residual `lit` in file contents or path components. */
function residual(treeObj, lit) {
  const hits = [];
  for (const [rel, content] of Object.entries(treeObj)) {
    if (content.toString("utf8").includes(lit)) hits.push(rel);
  }
  for (const rel of Object.keys(treeObj)) {
    if (rel.includes(lit)) hits.push(`PATH:${rel}`);
  }
  return hits;
}

test("invariant 1: `create-bclaw bclaw` output == template/", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-iv1-"));
  const res = await run(["bclaw"], tmp);
  assert.equal(res.code, 0, `cli failed: ${res.stderr}`);
  // Generated output has `.template` suffixes stripped on materialize; the
  // on-disk template keeps them, so normalize both sides before comparing.
  const generated = stripTemplateKeys(await tree(path.join(tmp, "bclaw")));
  const tmpl = stripTemplateKeys(await tree(TEMPLATE));
  assert.deepEqual(Object.keys(generated).sort(), Object.keys(tmpl).sort(), "file sets differ");
  assert.deepEqual(generated, tmpl, "contents differ from template/");
});

test("invariant 2: `create-bclaw foo` == bclaw output with bclaw→foo", async () => {
  const tmpBclaw = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-iv2-b-"));
  const tmpFoo = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-iv2-f-"));
  const rb = await run(["bclaw"], tmpBclaw);
  const rf = await run(["foo"], tmpFoo);
  assert.equal(rb.code, 0, `bclaw failed: ${rb.stderr}`);
  assert.equal(rf.code, 0, `foo failed: ${rf.stderr}`);
  const bclawTree = await tree(path.join(tmpBclaw, "bclaw"));
  const fooTree = await tree(path.join(tmpFoo, "foo"));
  const expected = renameTree(bclawTree, [["bclaw", "foo"]]);
  assert.deepEqual(Object.keys(fooTree).sort(), Object.keys(expected).sort(), "file sets differ");
  assert.deepEqual(fooTree, expected, "foo output is not bclaw output renamed");
});

test("invariant 3: zero residual `bclaw` in `foo` output", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-iv3-"));
  const res = await run(["foo"], tmp);
  assert.equal(res.code, 0, `cli failed: ${res.stderr}`);
  const fooTree = await tree(path.join(tmp, "foo"));
  const hits = residual(fooTree, "bclaw");
  assert.equal(hits.length, 0, `residual bclaw found: ${JSON.stringify(hits)}`);
});

test("invariant 2b: `create-bclaw foo --region us-west-2` == bclaw output renamed both tokens", async () => {
  const tmpBclaw = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-iv2b-b-"));
  const tmpFoo = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-iv2b-f-"));
  const rb = await run(["bclaw"], tmpBclaw);
  const rf = await run(["foo", "--region", "us-west-2"], tmpFoo);
  assert.equal(rb.code, 0, `bclaw failed: ${rb.stderr}`);
  assert.equal(rf.code, 0, `foo --region failed: ${rf.stderr}`);
  const bclawTree = await tree(path.join(tmpBclaw, "bclaw"));
  const fooTree = await tree(path.join(tmpFoo, "foo"));
  const expected = renameTree(bclawTree, [
    ["bclaw", "foo"],
    ["us-east-1", "us-west-2"],
  ]);
  assert.deepEqual(Object.keys(fooTree).sort(), Object.keys(expected).sort(), "file sets differ");
  assert.deepEqual(fooTree, expected, "foo output is not bclaw output renamed with both tokens");
});

test("invariant 3b: zero residual `us-east-1` in `foo --region us-west-2` output", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-iv3b-"));
  const res = await run(["foo", "--region", "us-west-2"], tmp);
  assert.equal(res.code, 0, `cli failed: ${res.stderr}`);
  const fooTree = await tree(path.join(tmp, "foo"));
  const hits = residual(fooTree, "us-east-1");
  assert.equal(hits.length, 0, `residual us-east-1 found: ${JSON.stringify(hits)}`);
});

test("CLI: invalid names are rejected", async () => {
  const cases = ["1starts-with-digit", "under_score", `x${"a".repeat(59)}`, "-leading-hyphen", ""];
  for (const bad of cases) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-bad-"));
    const res = await run([bad], tmp);
    assert.notEqual(res.code, 0, `expected rejection for name ${JSON.stringify(bad)}`);
  }
});

test("CLI: a 59-char name is accepted, 60 is rejected", async () => {
  const ok59 = `${"a".repeat(58)}z`; // 59 chars, starts with letter
  const bad60 = `${"a".repeat(59)}z`; // 60 chars
  const t1 = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-59-"));
  const t2 = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-60-"));
  assert.equal((await run([ok59], t1)).code, 0, "59-char name should be accepted");
  assert.notEqual((await run([bad60], t2)).code, 0, "60-char name should be rejected");
});

test("CLI: refuses a non-empty target without --force, allows with --force", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-force-"));
  const target = path.join(tmp, "foo");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "preexisting.txt"), "x");
  const refused = await run(["foo"], tmp);
  assert.notEqual(refused.code, 0, "should refuse non-empty target without --force");
  const forced = await run(["foo", "--force"], tmp);
  assert.equal(forced.code, 0, "should allow with --force");
});

test("CLI: unknown flags are rejected", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-unknown-"));
  const res = await run(["--bogus", "foo"], tmp);
  assert.notEqual(res.code, 0, "unknown flag --bogus should be rejected");
});

test("CLI: no name + non-TTY stdin exits non-zero with a hint", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-notty-"));
  // run() spawns with piped stdin → process.stdin.isTTY is undefined in the child,
  // so the CLI must refuse to fall back to an interactive prompt.
  const res = await run([], tmp);
  assert.notEqual(res.code, 0, "should refuse when no name given and stdin is not a TTY");
  assert.match(res.stderr, /stdin|name/i, "should explain why it refused");
});

test("CLI: a trailing hyphen in the name is rejected", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-trail-"));
  const res = await run(["foo-"], tmp);
  assert.notEqual(res.code, 0, "name ending with a hyphen should be rejected");
});

test("CLI: -V prints version; -v is not a version alias", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-ver-"));
  const ok = await run(["-V"], tmp);
  assert.equal(ok.code, 0, "-V should print version and exit 0");
  assert.match(ok.stdout, /\S/, "-V should print the version");
  const bad = await run(["-v"], tmp);
  assert.notEqual(bad.code, 0, "-v should be rejected (not a version alias)");
});

test("CLI: --region accepts a valid region", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-reg-ok-"));
  const res = await run(["foo", "--region", "eu-central-1"], tmp);
  assert.equal(res.code, 0, `valid region should be accepted: ${res.stderr}`);
});

test("CLI: --region rejects an invalid region", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-reg-bad-"));
  const res = await run(["foo", "--region", "not-a-region"], tmp);
  assert.notEqual(res.code, 0, "invalid region should be rejected");
});

test("CLI: a name colliding with the region token (us-east-1) is rejected", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-reg-name-"));
  const res = await run(["us-east-1"], tmp);
  assert.notEqual(
    res.code,
    0,
    "name == region token must be rejected to avoid region-pass corruption",
  );
});

test("generate: renames the token inside symlink targets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-sym-"));
  const src = path.join(tmp, "template");
  const out = path.join(tmp, "out");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "bclaw-target.txt"), "hi");
  // `.template` suffix is stripped on materialize → link becomes `foo-link`
  await fs.symlink("bclaw-target.txt", path.join(src, "bclaw-link.template"));
  await generate({ name: "foo", targetDir: out, templateDir: src, region: "us-east-1" });
  const target = await fs.readlink(path.join(out, "foo-link"));
  assert.equal(target, "foo-target.txt", "symlink target string should be renamed");
});

test("generate: substitutes the region token into contents", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bclaw-reg-gen-"));
  const out = path.join(tmp, "out");
  await generate({
    name: "foo",
    targetDir: out,
    templateDir: TEMPLATE,
    region: "us-west-2",
  });
  const policy = await fs.readFile(path.join(out, "foo-deploy-policy.json"), "utf8");
  assert.ok(
    policy.includes("ssm.us-west-2.amazonaws.com"),
    "kms:ViaService should be substituted to the chosen region",
  );
  assert.ok(!policy.includes("us-east-1"), "no residual us-east-1 should remain in the policy");
});
