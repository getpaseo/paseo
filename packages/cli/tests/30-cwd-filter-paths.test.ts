#!/usr/bin/env npx tsx

/**
 * CWD Filter Path Tests
 *
 * Tests that cwd filtering in agent commands works correctly
 * with both Unix and Windows-style paths.
 *
 * Bug: The original code used hardcoded "/" separators for:
 *   1. Stripping trailing separators (only stripped "/", not "\")
 *   2. Descendant matching (appended "/" instead of platform separator)
 *
 * This causes Windows paths like "C:\Users\dev\project" to fail matching
 * against "C:\Users\dev\project\sub" because the code appends "/" instead
 * of "\" for the startsWith check.
 */

import assert from "node:assert";
import { isSameOrDescendantPath } from "../src/utils/paths.ts";

console.log("=== CWD Filter Path Tests ===\n");

// Test 1: Unix exact match
{
  console.log("Test 1: Unix exact match");
  assert.strictEqual(
    isSameOrDescendantPath("/home/user/project", "/home/user/project"),
    true,
    "exact Unix paths should match",
  );
  console.log("✓ Unix exact match\n");
}

// Test 2: Unix descendant match
{
  console.log("Test 2: Unix descendant match");
  assert.strictEqual(
    isSameOrDescendantPath("/home/user/project", "/home/user/project/src"),
    true,
    "Unix descendant should match",
  );
  console.log("✓ Unix descendant match\n");
}

// Test 3: Unix non-match (sibling)
{
  console.log("Test 3: Unix non-match (sibling)");
  assert.strictEqual(
    isSameOrDescendantPath("/home/user/project", "/home/user/other"),
    false,
    "sibling directories should not match",
  );
  console.log("✓ Unix non-match (sibling)\n");
}

// Test 4: Unix prefix overlap (project vs project2)
{
  console.log("Test 4: Unix prefix overlap (project vs project2)");
  assert.strictEqual(
    isSameOrDescendantPath("/home/user/project", "/home/user/project2"),
    false,
    "prefix overlap without separator should not match",
  );
  console.log("✓ Unix prefix overlap\n");
}

// Test 5: Unix trailing slash on base
{
  console.log("Test 5: Unix trailing slash on base");
  assert.strictEqual(
    isSameOrDescendantPath("/home/user/project/", "/home/user/project/src"),
    true,
    "trailing slash on base should still match descendants",
  );
  console.log("✓ Unix trailing slash on base\n");
}

// Test 6: Unix trailing slash on candidate
{
  console.log("Test 6: Unix trailing slash on candidate");
  assert.strictEqual(
    isSameOrDescendantPath("/home/user/project", "/home/user/project/"),
    true,
    "trailing slash on candidate should match as same dir",
  );
  console.log("✓ Unix trailing slash on candidate\n");
}

// Test 7: Windows exact match
{
  console.log("Test 7: Windows exact match");
  assert.strictEqual(
    isSameOrDescendantPath("C:\\Users\\dev\\project", "C:\\Users\\dev\\project"),
    true,
    "exact Windows paths should match",
  );
  console.log("✓ Windows exact match\n");
}

// Test 8: Windows descendant match
{
  console.log("Test 8: Windows descendant match");
  assert.strictEqual(
    isSameOrDescendantPath("C:\\Users\\dev\\project", "C:\\Users\\dev\\project\\src"),
    true,
    "Windows descendant should match",
  );
  console.log("✓ Windows descendant match\n");
}

// Test 9: Windows non-match (sibling)
{
  console.log("Test 9: Windows non-match (sibling)");
  assert.strictEqual(
    isSameOrDescendantPath("C:\\Users\\dev\\project", "C:\\Users\\dev\\other"),
    false,
    "Windows sibling directories should not match",
  );
  console.log("✓ Windows non-match (sibling)\n");
}

// Test 10: Windows prefix overlap (project vs project2)
{
  console.log("Test 10: Windows prefix overlap (project vs project2)");
  assert.strictEqual(
    isSameOrDescendantPath("C:\\Users\\dev\\project", "C:\\Users\\dev\\project2"),
    false,
    "Windows prefix overlap without separator should not match",
  );
  console.log("✓ Windows prefix overlap\n");
}

// Test 11: Windows trailing backslash on base
{
  console.log("Test 11: Windows trailing backslash on base");
  assert.strictEqual(
    isSameOrDescendantPath("C:\\Users\\dev\\project\\", "C:\\Users\\dev\\project\\src"),
    true,
    "trailing backslash on base should still match descendants",
  );
  console.log("✓ Windows trailing backslash on base\n");
}

// Test 12: Windows trailing backslash on candidate
{
  console.log("Test 12: Windows trailing backslash on candidate");
  assert.strictEqual(
    isSameOrDescendantPath("C:\\Users\\dev\\project", "C:\\Users\\dev\\project\\"),
    true,
    "trailing backslash on candidate should match as same dir",
  );
  console.log("✓ Windows trailing backslash on candidate\n");
}

// Test 13: Mixed separators (agent might use \ while CLI sends /)
{
  console.log("Test 13: Mixed separators");
  assert.strictEqual(
    isSameOrDescendantPath("C:/Users/dev/project", "C:\\Users\\dev\\project\\src"),
    true,
    "mixed separators should still match",
  );
  console.log("✓ Mixed separators\n");
}

// Test 14: Deep Windows descendant
{
  console.log("Test 14: Deep Windows descendant");
  assert.strictEqual(
    isSameOrDescendantPath(
      "C:\\Users\\dev\\project",
      "C:\\Users\\dev\\project\\src\\components\\Button.tsx",
    ),
    true,
    "deep Windows descendant should match",
  );
  console.log("✓ Deep Windows descendant\n");
}

// Test 15: Case-insensitive Windows descendant match
{
  console.log("Test 15: Case-insensitive Windows descendant match");
  assert.strictEqual(
    isSameOrDescendantPath("C:\\Users\\Dev\\Project", "c:\\users\\dev\\project\\src"),
    true,
    "Windows paths with different casing should match (case-insensitive)",
  );
  console.log("✓ Case-insensitive Windows descendant match\n");
}

// Test 16: Case-insensitive Windows exact match
{
  console.log("Test 16: Case-insensitive Windows exact match");
  assert.strictEqual(
    isSameOrDescendantPath("c:\\repo", "C:\\Repo"),
    true,
    "Windows paths with different casing should match exactly (case-insensitive)",
  );
  console.log("✓ Case-insensitive Windows exact match\n");
}

// Test 17: Parent should not match
{
  console.log("Test 15: Parent should not match");
  assert.strictEqual(
    isSameOrDescendantPath("/home/user/project/src", "/home/user/project"),
    false,
    "parent directory should not match (only same-or-descendant)",
  );
  console.log("✓ Parent should not match\n");
}

console.log("=== All CWD filter path tests passed ===");
