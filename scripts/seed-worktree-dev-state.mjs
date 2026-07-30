#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// Worktree setup runs through a stable script shell: bash on macOS/Linux, but PowerShell
// on Windows. POSIX-only command strings (`VAR=1 cmd` env prefixes, `$VAR` expansion, `cp`,
// `./scripts/*.sh`) cannot express this step portably, so the seeding lives in Node — the
// one interpreter every Paseo checkout already depends on.

const sourceRoot = process.env.PASEO_SOURCE_CHECKOUT_PATH;
const targetRoot = process.env.PASEO_WORKTREE_PATH || process.cwd();

if (!sourceRoot || sourceRoot === targetRoot) {
  process.exit(0);
}

seedPaseoHome();
copyServerEnv();

function seedPaseoHome() {
  const source = process.env.PASEO_DEV_SEED_HOME || join(sourceRoot, ".dev/paseo-home");
  const target = join(targetRoot, ".dev/paseo-home");

  if (!existsSync(source)) {
    console.log(`  Seed:    skipped (${source} missing)`);
    return;
  }

  if (source === target) {
    console.log("  Seed:    skipped (source is target)");
    return;
  }

  if (process.env.PASEO_DEV_RESET_HOME === "1") {
    rmSync(target, { recursive: true, force: true });
  } else if (hasEntries(target)) {
    console.log(`  Seed:    skipped (${target} already has data)`);
    return;
  }

  mkdirSync(target, { recursive: true });
  console.log(`  Seed:    copying metadata from ${source}`);
  copyJsonTree(join(source, "agents"), join(target, "agents"));
  copyJsonTree(join(source, "projects"), join(target, "projects"));

  const config = join(source, "config.json");
  if (existsSync(config)) {
    cpSync(config, join(target, "config.json"));
  }

  console.log(`  Seed:    copied metadata from ${source}`);
}

// Durable JSON metadata only. Runtime files (pid files, sockets, logs) must not be copied.
function copyJsonTree(source, target) {
  if (!existsSync(source)) {
    return;
  }

  cpSync(source, target, {
    recursive: true,
    filter: (path) => isDirectory(path) || path.endsWith(".json"),
  });
}

function copyServerEnv() {
  const source = join(sourceRoot, "packages/server/.env");
  const target = join(targetRoot, "packages/server/.env");

  // Untracked local config. A checkout without one is normal, so this is not a setup failure.
  if (!existsSync(source)) {
    console.log(`  Env:     skipped (${source} missing)`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  console.log(`  Env:     copied ${source}`);
}

function hasEntries(path) {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
