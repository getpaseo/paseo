#!/usr/bin/env npx zx

/**
 * Phase 1: Foundation Tests
 *
 * Tests basic CLI functionality that doesn't require a daemon:
 * - hubcode --version outputs version
 * - hubcode --help shows commands
 */

import { $ } from "zx";

$.verbose = false;

console.log("📋 Phase 1: Foundation Tests\n");

// Test 1.1: --version outputs version
console.log("  Testing hubcode --version...");
const versionResult = await $`hubcode --version`.nothrow();
if (versionResult.exitCode !== 0) {
  console.error("  ❌ hubcode --version failed with exit code", versionResult.exitCode);
  console.error("     stderr:", versionResult.stderr);
  process.exit(1);
}
const versionOutput = versionResult.stdout.trim();
if (!versionOutput.match(/\d+\.\d+\.\d+/)) {
  console.error("  ❌ hubcode --version output does not contain version number");
  console.error("     output:", versionOutput);
  process.exit(1);
}
console.log("  ✅ hubcode --version outputs:", versionOutput);

// Test 1.2: --help shows commands
console.log("  Testing hubcode --help...");
const helpResult = await $`hubcode --help`.nothrow();
if (helpResult.exitCode !== 0) {
  console.error("  ❌ hubcode --help failed with exit code", helpResult.exitCode);
  console.error("     stderr:", helpResult.stderr);
  process.exit(1);
}
const helpOutput = helpResult.stdout;

// Check for expected sections in help output
const expectedTerms = ["agent", "daemon", "Usage", "Options", "Commands"];
const missingTerms = expectedTerms.filter((term) => !helpOutput.includes(term));
if (missingTerms.length > 0) {
  console.error("  ❌ hubcode --help missing expected terms:", missingTerms.join(", "));
  console.error("     output:", helpOutput);
  process.exit(1);
}
console.log("  ✅ hubcode --help shows commands");

console.log("\n✅ Phase 1: Foundation Tests PASSED");
