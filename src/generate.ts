import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * The single rename token. Every occurrence in the source template is
 * lowercase and standalone (no `Bclaw`, no glued substrings), so a literal
 * substring replace is the whole transform. See RFC §Rename model.
 */
const RENAME_FROM = "bclaw";

/** Trailing suffix stripped from basenames on generate (e.g. `.gitignore.template` → `.gitignore`). */
const TEMPLATE_SUFFIX = ".template";

export interface GenerateOptions {
  /** The new claw name (already validated by the CLI). */
  name: string;
  /** Absolute path to the output directory to create. */
  targetDir: string;
  /** Absolute path to the bundled template/ directory. */
  templateDir: string;
}

/**
 * Copy `template/` → `targetDir/`, applying the literal `bclaw`→`name` replace
 * to file contents AND path components, then assert no residual token remains
 * and `git init` the result.
 */
export async function generate(opts: GenerateOptions): Promise<void> {
  const { name, targetDir, templateDir } = opts;

  try {
    const stat = await fs.stat(templateDir);
    if (!stat.isDirectory()) {
      throw new Error(`not a directory`);
    }
  } catch (error) {
    throw new Error(
      `template not found at ${templateDir} (${error instanceof Error ? error.message : error})`,
    );
  }

  await fs.mkdir(targetDir, { recursive: true });
  await copyTree(templateDir, targetDir, name);

  // Hard post-copy assertion: zero residual `bclaw` in contents and path
  // components. Skipped when the name itself is or contains the token, because
  // a literal grep would flag the legitimate replacement (e.g. name == "bclaw"
  // is a no-op rename; name == "mybclaw" embeds the token).
  if (!name.includes(RENAME_FROM)) {
    await assertNoResidual(targetDir, RENAME_FROM);
  }

  // Best-effort VCS init — the generated dir is its own git project. Failures
  // (no git binary, etc.) warn but never fail the scaffold, which is the
  // primary deliverable.
  await gitInit(targetDir).catch((error) => {
    process.stderr.write(
      `warning: git init/commit skipped (${error instanceof Error ? error.message : error})\n`,
    );
  });
}

/** Recursively copy src→dest, renaming the token in path components + contents. */
async function copyTree(src: string, dest: string, name: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    // Rename the `bclaw` token in path components, then strip a trailing
    // `.template` suffix from the basename. The suffix marks files npm's
    // packlist would otherwise drop on publish (e.g. `.gitignore`), so they
    // ship as `.gitignore.template` and materialize correctly on generate.
    let destName = entry.name.split(RENAME_FROM).join(name);
    if (!entry.isDirectory() && destName.endsWith(TEMPLATE_SUFFIX)) {
      destName = destName.slice(0, -TEMPLATE_SUFFIX.length);
    }
    const destPath = path.join(dest, destName);
    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath, name);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(srcPath);
      // Apply the token rename to the link target STRING (not the file it
      // resolves to); otherwise a `bclaw`-bearing target survives the rename
      // and dangles, pointing at a now-nonexistent path.
      const renamedTarget =
        typeof target === "string" ? target.split(RENAME_FROM).join(name) : target;
      await fs.symlink(renamedTarget, destPath);
    } else {
      await copyFile(srcPath, destPath, name);
    }
  }
}

async function copyFile(src: string, dest: string, name: string): Promise<void> {
  const buf = await fs.readFile(src);
  // Every template file is text. Treat any NUL byte as binary and copy
  // verbatim so the rename never corrupts a binary blob.
  if (buf.length > 0 && buf.includes(0)) {
    await fs.writeFile(dest, buf);
  } else {
    await fs.writeFile(dest, buf.toString("utf8").split(RENAME_FROM).join(name), "utf8");
  }
}

/** Walk root (skipping .git) and fail if any file content, path, or symlink target has the token. */
async function assertNoResidual(root: string, token: string): Promise<void> {
  const hits: string[] = [];
  async function scan(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const p = path.join(dir, entry.name);
      const rel = path.relative(root, p);
      if (entry.name.includes(token)) hits.push(`path:   ${rel}`);
      if (entry.isDirectory()) {
        await scan(p);
      } else if (entry.isSymbolicLink()) {
        // Inspect the link target STRING. readFile would follow the link —
        // reading the target's contents (or throwing ENOENT on a dangling
        // link) — and miss a token encoded in the target path itself.
        const linkTarget = await fs.readlink(p).catch(() => "");
        if (typeof linkTarget === "string" && linkTarget.includes(token)) {
          hits.push(`symlink: ${rel} -> ${linkTarget}`);
        }
      } else {
        const buf = await fs.readFile(p);
        if (!(buf.length > 0 && buf.includes(0)) && buf.toString("utf8").includes(token)) {
          hits.push(`content: ${rel}`);
        }
      }
    }
  }
  await scan(root);
  if (hits.length > 0) {
    throw new Error(
      `residual "${token}" found after rename (${hits.length} sites):\n  ${hits.slice(0, 25).join("\n  ")}`,
    );
  }
}

/** `git init` + initial commit in dir, using a local identity if none is set. */
async function gitInit(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet"]);
  if (!(await gitConfig(dir, "user.email"))) {
    await git(dir, ["config", "user.email", "create-bclaw@local"]);
  }
  if (!(await gitConfig(dir, "user.name"))) {
    await git(dir, ["config", "user.name", "create-bclaw"]);
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", "Initial commit from @boldblackai/create-bclaw"]);
}

async function gitConfig(dir: string, key: string): Promise<string> {
  try {
    return await git(dir, ["config", key]);
  } catch {
    return "";
  }
}

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else {
        reject(new Error(`git ${args.join(" ")} exited ${code}${err ? `: ${err.trim()}` : ""}`));
      }
    });
  });
}
