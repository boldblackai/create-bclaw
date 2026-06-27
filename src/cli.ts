#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { generate } from "./generate.js";

const NAME_RE = /^[a-zA-Z]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const MAX_NAME_LEN = 59;
const MIN_NAME_LEN = 1;
const KNOWN_FLAGS = new Set(["--force", "--version", "-V", "--help", "-h"]);

const here = path.dirname(fileURLToPath(import.meta.url)); // .../dist

function templateDir(): string {
  return path.resolve(here, "..", "template");
}

function pkgVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(here, "..", "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  const help = [
    "@boldblackai/create-bclaw — scaffold a bclaw repository",
    "",
    "Usage:",
    "  npx @boldblackai/create-bclaw <name>       generate ./<name>/",
    "  npm init @boldblackai/bclaw <name>          (equivalent)",
    "",
    "Options:",
    "  --force       write into a non-empty target (merges; overwrites existing files)",
    "  --version, -V print version and exit",
    "  --help, -h    show this help and exit",
    "",
    `<name> must match ${NAME_RE.source} and be 1–59 chars long. It becomes`,
    "the CloudFormation stack name, IAM role prefix, ECS cluster/service, log",
    "group, SSM namespace, KMS alias, and EFS tag.",
  ].join("\n");
  console.log(help);
}

function isNonEmptyDir(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).length > 0;
}

function bail(message: string): never {
  p.cancel(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("-"));
  const positional = args.filter((a) => !a.startsWith("-"));
  const force = flags.includes("--force");

  if (flags.includes("--version") || flags.includes("-V")) {
    console.log(pkgVersion());
    return;
  }
  if (flags.includes("--help") || flags.includes("-h")) {
    printHelp();
    return;
  }

  p.intro("@boldblackai/create-bclaw");

  const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    bail(`unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (see --help)`);
  }

  let name = positional[0];
  const nameFromArg = typeof name === "string";
  if (!nameFromArg) {
    if (!process.stdin.isTTY) {
      bail("no claw name provided and stdin is not a TTY — pass the name as an argument");
    }
    const prompted = await p.text({
      message: "Claw name?",
      placeholder: "bclaw",
      defaultValue: "bclaw",
      validate: (v) => {
        const s = String(v ?? "").trim();
        if (!NAME_RE.test(s) || s.length < MIN_NAME_LEN || s.length > MAX_NAME_LEN) {
          return `must match ${NAME_RE.source} and be ${MIN_NAME_LEN}–${MAX_NAME_LEN} chars`;
        }
      },
    });
    if (p.isCancel(prompted)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    name = String(prompted ?? "bclaw").trim();
  }
  name = String(name).trim();

  if (!NAME_RE.test(name) || name.length < MIN_NAME_LEN || name.length > MAX_NAME_LEN) {
    bail(
      `invalid name "${name}": must match ${NAME_RE.source} and be ${MIN_NAME_LEN}–${MAX_NAME_LEN} chars`,
    );
  }

  const targetDir = path.resolve(process.cwd(), name);
  if (isNonEmptyDir(targetDir) && !force) {
    bail(`target ${targetDir} is not empty (use --force to overwrite)`);
  }

  if (!nameFromArg) {
    const ok = await p.confirm({
      message: `Generate claw "${name}" into ${targetDir}?`,
      initialValue: true,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("cancelled");
      process.exit(0);
    }
  }

  try {
    await generate({ name, targetDir, templateDir: templateDir() });
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  p.note(
    [
      `cd ${name}`,
      "mise install && mise trust",
      "follow README.md → Setup (IAM user, policy, .env, Slack app, secrets)",
      "run the setup-harness-ecs-fargate skill to deploy",
    ].join("\n"),
    "Next steps",
  );
  p.outro(`done — ${name}/ is ready`);
}

await main();
