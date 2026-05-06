#!/usr/bin/env npx tsx

/**
 * Regression: executable daemon launch commands must enter the supervisor.
 * The worker entry remains an implementation detail of supervisor-entrypoint.
 */

import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../../..");
const serverPackagePath = join(repoRoot, "packages/server/package.json");
const appGlobalSetupPath = join(repoRoot, "packages/app/e2e/global-setup.ts");
const serverConnectionOfferE2ePath = join(
  repoRoot,
  "packages/server/src/server/daemon-e2e/connection-offer.e2e.test.ts",
);
const desktopRuntimePathsPath = join(repoRoot, "packages/desktop/src/daemon/runtime-paths.ts");
const nixPackagePath = join(repoRoot, "nix/package.nix");

function assertNoDirectWorkerLaunch(label: string, command: string): void {
  assert(
    !command.includes("src/server/index.ts"),
    `${label} must not launch src/server/index.ts directly: ${command}`,
  );
  assert(
    !command.includes("dist/server/server/index.js"),
    `${label} must not launch dist/server/server/index.js directly: ${command}`,
  );
  assert(
    !command.includes("src/server/daemon-worker.ts"),
    `${label} must not launch src/server/daemon-worker.ts directly: ${command}`,
  );
  assert(
    !command.includes("dist/server/server/daemon-worker.js"),
    `${label} must not launch dist/server/server/daemon-worker.js directly: ${command}`,
  );
}

function assertNoSpawnedWorkerEntrypoint(label: string, source: string): void {
  assertNoDirectWorkerLaunch(label, source);
  assert(
    !/spawn\([^)]*["'`][^"'`]*\.\.\/index\.ts["'`]/s.test(source),
    `${label} must not spawn ../index.ts directly`,
  );
}

console.log("=== Daemon Launch Supervision Regression ===\n");

console.log("Test 1: server package scripts launch supervisor-entrypoint");
const serverPackage = JSON.parse(await readFile(serverPackagePath, "utf-8")) as {
  scripts?: Record<string, string>;
};
const startScript = serverPackage.scripts?.start ?? "";
const devScript = serverPackage.scripts?.dev ?? "";
const devTsxScript = serverPackage.scripts?.["dev:tsx"] ?? "";

assert(startScript.includes("dist/scripts/supervisor-entrypoint.js"), startScript);
assertNoDirectWorkerLaunch("server start script", startScript);
assert(devScript.includes("scripts/dev-runner.ts"), devScript);
assertNoDirectWorkerLaunch("server dev script", devScript);
assert(devTsxScript.includes("scripts/dev-runner.ts"), devTsxScript);
assertNoDirectWorkerLaunch("server dev:tsx script", devTsxScript);
console.log("✓ server package scripts enter supervisor\n");

console.log("Test 2: app e2e global setup launches supervisor-entrypoint in dev mode");
const appGlobalSetup = await readFile(appGlobalSetupPath, "utf-8");
assert(
  appGlobalSetup.includes('spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"]'),
  "app e2e setup should spawn supervisor-entrypoint.ts with --dev",
);
assertNoSpawnedWorkerEntrypoint("app e2e global setup", appGlobalSetup);
console.log("✓ app e2e setup enters supervisor\n");

console.log("Test 3: server daemon e2e process launch enters supervisor");
const serverConnectionOfferE2e = await readFile(serverConnectionOfferE2ePath, "utf-8");
assert(
  serverConnectionOfferE2e.includes("scripts/supervisor-entrypoint.ts"),
  "server daemon e2e process launch should use supervisor-entrypoint.ts",
);
assertNoSpawnedWorkerEntrypoint("server daemon e2e process launch", serverConnectionOfferE2e);
console.log("✓ server daemon e2e process launch enters supervisor\n");

console.log("Test 4: desktop runtime and Nix wrapper point at supervisor-entrypoint");
const desktopRuntimePaths = await readFile(desktopRuntimePathsPath, "utf-8");
assert(
  desktopRuntimePaths.includes('"dist", "scripts", "supervisor-entrypoint.js"'),
  "desktop packaged daemon runner should resolve dist/scripts/supervisor-entrypoint.js",
);
assert(
  desktopRuntimePaths.includes('"scripts", "supervisor-entrypoint.ts"'),
  "desktop dev daemon runner should resolve scripts/supervisor-entrypoint.ts",
);
assertNoDirectWorkerLaunch("desktop runtime paths", desktopRuntimePaths);

const nixPackage = await readFile(nixPackagePath, "utf-8");
assert(
  nixPackage.includes("dist/scripts/supervisor-entrypoint.js"),
  "Nix paseo-server wrapper should use dist/scripts/supervisor-entrypoint.js",
);
assertNoDirectWorkerLaunch("Nix package wrapper", nixPackage);
console.log("✓ desktop runtime and Nix wrapper enter supervisor\n");

console.log("=== Daemon launch supervision regression test passed ===");
