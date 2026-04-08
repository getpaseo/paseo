#!/usr/bin/env npx zx

import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyInvocation, isExistingDirectory, isPathLikeArg } from "../src/classify.ts";
import { openDesktopWithProject } from "../src/commands/open.ts";

console.log("📋 Phase 32: Open Project CLI Tests\n");

console.log("  Testing path-like detection exports...");
assert.equal(isPathLikeArg("."), true);
assert.equal(isPathLikeArg("./app"), true);
assert.equal(isPathLikeArg("/tmp/app"), true);
assert.equal(isPathLikeArg("~/app"), true);
assert.equal(isPathLikeArg("run"), false);
assert.equal(isPathLikeArg("foo"), false);
console.log("  ✅ path-like detection matches the expected prefixes");

console.log("  Testing existing directory detection and command precedence...");
const existingProject = join(await mkdtemp(join(tmpdir(), "paseo-open-project-")), "project");
await mkdir(existingProject);
const originalCwd = process.cwd();
process.chdir(join(existingProject, ".."));

assert.equal(isExistingDirectory({ pathArg: "project", cwd: process.cwd() }), true);
assert.equal(
  classifyInvocation({
    argv: ["project"],
    knownCommands: new Set(["run", "status"]),
    cwd: process.cwd(),
  }).kind,
  "open-project",
);
assert.equal(
  classifyInvocation({
    argv: ["run"],
    knownCommands: new Set(["run", "status"]),
    cwd: process.cwd(),
  }).kind,
  "cli",
);

process.chdir(originalCwd);
console.log("  ✅ existing directories open as projects, but known commands still win");

console.log("  Testing desktop CLI passthrough guard...");
const originalWrite = process.stderr.write.bind(process.stderr);
const stderrChunks: string[] = [];
process.stderr.write = ((chunk: string | Uint8Array) => {
  stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return true;
}) as typeof process.stderr.write;

const previousExitCode = process.exitCode;
process.exitCode = undefined;
const previousDesktopCli = process.env.PASEO_DESKTOP_CLI;
process.env.PASEO_DESKTOP_CLI = "1";

await openDesktopWithProject(existingProject);

process.stderr.write = originalWrite;
assert.equal(process.exitCode, 1);
assert.match(stderrChunks.join(""), /desktop CLI passthrough mode/);
process.exitCode = previousExitCode;
process.env.PASEO_DESKTOP_CLI = previousDesktopCli;
console.log("  ✅ desktop CLI passthrough mode is rejected");

console.log("\n✅ Phase 32: Open Project CLI Tests PASSED");
