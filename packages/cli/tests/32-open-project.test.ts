#!/usr/bin/env npx zx

import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPathLikeArg, openDesktopWithProject } from "../src/commands/open.ts";

console.log("📋 Phase 32: Open Project CLI Tests\n");

console.log("  Testing path-like detection exports...");
assert.equal(isPathLikeArg("."), true);
assert.equal(isPathLikeArg("./app"), true);
assert.equal(isPathLikeArg("/tmp/app"), true);
assert.equal(isPathLikeArg("~/app"), true);
assert.equal(isPathLikeArg("run"), false);
assert.equal(isPathLikeArg("foo"), false);
console.log("  ✅ path-like detection matches the expected prefixes");

console.log("  Testing nonexistent project path errors...");
const missingProject = join(tmpdir(), "paseo-open-project-missing");
const originalWrite = process.stderr.write.bind(process.stderr);
const stderrChunks: string[] = [];
process.stderr.write = ((chunk: string | Uint8Array) => {
  stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return true;
}) as typeof process.stderr.write;

const previousExitCode = process.exitCode;
process.exitCode = undefined;

await openDesktopWithProject(missingProject);

process.stderr.write = originalWrite;
assert.equal(process.exitCode, 1);
assert.match(stderrChunks.join(""), /Path does not exist:/);
process.exitCode = previousExitCode;
console.log("  ✅ nonexistent paths fail with a helpful error");

console.log("\n✅ Phase 32: Open Project CLI Tests PASSED");
