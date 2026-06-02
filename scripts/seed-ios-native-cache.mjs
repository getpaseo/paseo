#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const sourceRoot = process.env.PASEO_SOURCE_CHECKOUT_PATH;
const targetRoot = process.env.PASEO_WORKTREE_PATH || process.cwd();

if (process.env.PASEO_SKIP_IOS_NATIVE_CACHE === "1") {
  process.exit(0);
}

if (!sourceRoot || sourceRoot === targetRoot) {
  process.exit(0);
}

seedDirectory({
  label: "iOS project",
  source: join(sourceRoot, "packages/app/ios"),
  target: join(targetRoot, "packages/app/ios"),
});

seedDirectory({
  label: "iOS derived data",
  source: newestDirectory(join(sourceRoot, ".dev/ios-build")),
  target: join(targetRoot, ".dev/ios-build", simulatorSlug()),
});

function seedDirectory({ label, source, target }) {
  if (!source || !existsSync(source) || existsSync(target)) {
    return;
  }

  try {
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: false,
      force: false,
    });
    console.log(`Seeded ${label} cache from ${source}`);
  } catch (error) {
    console.warn(`Skipping ${label} cache seed: ${error instanceof Error ? error.message : error}`);
  }
}

function newestDirectory(parent) {
  try {
    return readdirSync(parent)
      .map((name) => join(parent, name))
      .filter((path) => statSync(path).isDirectory())
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  } catch {
    return null;
  }
}

function simulatorSlug() {
  const worktreeName = process.env.PASEO_BRANCH_NAME || basename(targetRoot);
  const worktreeHash = createHash("sha1").update(targetRoot).digest("hex").slice(0, 8);
  const simulatorName = `Paseo ${worktreeName} ${worktreeHash}`;
  return `${simulatorName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${worktreeHash}`;
}
