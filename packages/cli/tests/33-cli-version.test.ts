#!/usr/bin/env npx tsx

import assert from "node:assert";
import { resolveCliVersion } from "../src/utils/version.ts";

console.log("=== CLI Version Helper ===\n");

{
  console.log("Test 1: resolves the CLI package version");
  assert.match(resolveCliVersion(), /^\d+\.\d+\.\d+(?:-.+)?$/);
  console.log("✓ resolves the CLI package version\n");
}

console.log("=== All CLI version helper tests passed ===");
