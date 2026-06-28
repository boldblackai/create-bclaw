#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
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

function nameRule(): string {
  return `must match ${NAME_RE.source} and be ${MIN_NAME_LEN}–${MAX_NAME_LEN} chars`;
}

function validName(s: string): boolean {
  return NAME_RE.test(s) && s.length >= MIN_NAME_LEN && s.length <= MAX_NAME_LEN;
}

/** Print a diagnostic to stderr and exit non-zero. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** User-initiated cancellation (Ctrl-C / EOF at a prompt). */
function cancelled(): never {
  process.stderr.write("cancelled\n");
  process.exit(0);
}

async function askName(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  rl.on("SIGINT", cancelled);
  try {
    while (true) {
      const answer = await rl.question("Claw name? (bclaw) ").catch(() => null);
      if (answer === null) cancelled();
      const s = (answer ?? "").trim() || "bclaw";
      if (validName(s)) return s;
      process.stderr.write(`${nameRule()} — try again\n`);
    }
  } finally {
    rl.close();
  }
}

async function askConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  rl.on("SIGINT", cancelled);
  try {
    while (true) {
      const answer = await rl.question(`${message} [Y/n] `).catch(() => null);
      if (answer === null) cancelled();
      const a = (answer ?? "").trim().toLowerCase();
      if (a === "" || a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
    }
  } finally {
    rl.close();
  }
}

function printNextSteps(name: string): void {
  const steps = [
    `cd ${name}`,
    "mise install && mise trust",
    "follow README.md → Setup (IAM user, policy, .env, Slack app, secrets)",
    `run the setup-${name} skill to deploy`,
  ];
  console.log("\nNext steps:");
  for (const s of steps) console.log(`  ${s}`);
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

  console.log("@boldblackai/create-bclaw");

  const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    fail(`unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (see --help)`);
  }

  let name = positional[0];
  const nameFromArg = typeof name === "string";
  if (!nameFromArg) {
    if (!process.stdin.isTTY) {
      fail("no claw name provided and stdin is not a TTY — pass the name as an argument");
    }
    name = await askName();
  }
  name = String(name).trim();

  if (!validName(name)) {
    fail(`invalid name "${name}": ${nameRule()}`);
  }

  const targetDir = path.resolve(process.cwd(), name);
  if (isNonEmptyDir(targetDir) && !force) {
    fail(`target ${targetDir} is not empty (use --force to overwrite)`);
  }

  if (!nameFromArg) {
    const ok = await askConfirm(`Generate claw "${name}" into ${targetDir}?`);
    if (!ok) cancelled();
  }

  try {
    await generate({ name, targetDir, templateDir: templateDir() });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  printNextSteps(name);
  console.log(`done — ${name}/ is ready`);
}

await main();
