import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const scriptPath = new URL("./postinstall-patches.mjs", import.meta.url);

function runPostinstall({ installPatchedPackage, env = {} }) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "paseo-postinstall-patches-"));
  const isolatedScript = join(fixtureRoot, "postinstall-patches.mjs");
  cpSync(scriptPath, isolatedScript);
  mkdirSync(join(fixtureRoot, "patches"));
  writeFileSync(
    join(fixtureRoot, "patches", "react-native-markdown-display+7.0.2.patch"),
    "patch contents are not read when patch-package is missing\n",
  );
  if (installPatchedPackage) {
    mkdirSync(join(fixtureRoot, "node_modules", "react-native-markdown-display"), {
      recursive: true,
    });
  }

  const result = spawnSync(process.execPath, [isolatedScript], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  rmSync(fixtureRoot, { recursive: true, force: true });
  return result;
}

test.each([
  ["NODE_ENV=production", { NODE_ENV: "production" }],
  ["--omit=dev", { npm_config_omit: "dev" }],
])("fails when an applicable patch cannot be applied under %s", (_name, env) => {
  const result = runPostinstall({ installPatchedPackage: true, env });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /installed dependencies require patches/);
  assert.match(result.stderr, /npm ci --include=dev/);
  assert.doesNotMatch(result.stderr, /skipping patches/);
});

test("allows installs with no applicable patched packages", () => {
  const result = runPostinstall({
    installPatchedPackage: false,
    env: { NODE_ENV: "production", npm_config_omit: "dev" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});
