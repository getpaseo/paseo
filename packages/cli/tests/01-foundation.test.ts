#!/usr/bin/env npx zx

/**
 * Phase 1: Foundation Tests
 *
 * Tests basic CLI functionality that doesn't require a daemon:
 * - paseo --version outputs version
 * - paseo --help shows commands
 */

import { runLocalPaseo } from "./helpers/local-cli.js";
import assert from "node:assert/strict";

console.log("📋 Phase 1: Foundation Tests\n");

// Test 1.1: --version outputs version
console.log("  Testing paseo --version...");
const versionResult = await runLocalPaseo(["--version"]);
if (versionResult.exitCode !== 0) {
  console.error("  ❌ paseo --version failed with exit code", versionResult.exitCode);
  console.error("     stderr:", versionResult.stderr);
  process.exit(1);
}
const versionOutput = versionResult.stdout.trim();
if (!versionOutput.match(/\d+\.\d+\.\d+/)) {
  console.error("  ❌ paseo --version output does not contain version number");
  console.error("     output:", versionOutput);
  process.exit(1);
}
console.log("  ✅ paseo --version outputs:", versionOutput);

// Test 1.2: --help shows commands
console.log("  Testing paseo --help...");
const helpResult = await runLocalPaseo(["--help"]);
if (helpResult.exitCode !== 0) {
  console.error("  ❌ paseo --help failed with exit code", helpResult.exitCode);
  console.error("     stderr:", helpResult.stderr);
  process.exit(1);
}
const helpOutput = helpResult.stdout;

// Check for expected sections in help output
const expectedTerms = ["agent", "daemon", "Usage", "Options", "Commands"];
const missingTerms = expectedTerms.filter((term) => !helpOutput.includes(term));
if (missingTerms.length > 0) {
  console.error("  ❌ paseo --help missing expected terms:", missingTerms.join(", "));
  console.error("     output:", helpOutput);
  process.exit(1);
}
console.log("  ✅ paseo --help shows commands");

const observeImports = `
  import { register } from "node:module";
  register("data:text/javascript," + encodeURIComponent(\`
    export async function load(url, context, nextLoad) {
      if (url.endsWith("/run.js")) process.stderr.write("command stack loaded");
      return nextLoad(url, context);
    }
  \`));
`;
for (const flag of ["--version", "-v"]) {
  const result = await runLocalPaseo([flag], {
    NODE_OPTIONS: "--import=data:text/javascript," + encodeURIComponent(observeImports),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), versionOutput);
  assert.equal(result.stderr, "", "version must not load the command stack");
}
console.log("  ✅ version flags avoid loading the command stack");

console.log("\n✅ Phase 1: Foundation Tests PASSED");
