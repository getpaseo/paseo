#!/usr/bin/env npx tsx

import assert from "node:assert";
import { resolveAgentId } from "../src/utils/client.js";

console.log("=== Agent ID Resolution Tests ===\n");

const agents = [
  { id: "abc1234-full-agent-id", title: "Build docs" },
  { id: "def5678-other-agent-id", title: "Fix archive flow" },
  { id: "987zyxw-third-agent-id", title: "Review PR" },
];

{
  console.log("Test 1: exact ID match resolves");
  assert.strictEqual(resolveAgentId("abc1234-full-agent-id", agents), "abc1234-full-agent-id");
  console.log("✓ exact ID match resolves\n");
}

{
  console.log("Test 2: full UUID resolves exactly, case-insensitively");
  const exactId = "9eac296c-4d60-4189-a0b5-ae71dd9c6ad9";
  const agentsWithNameCollision = [
    { id: exactId, title: "target agent" },
    {
      id: "c9a97e5d-4a92-4646-a016-53032146d0a1",
      title: `worker ${exactId}`,
    },
  ];
  assert.strictEqual(resolveAgentId(exactId.toUpperCase(), agentsWithNameCollision), exactId);
  console.log("✓ full UUID resolves exactly, case-insensitively\n");
}

{
  console.log("Test 3: missing full UUID does not match another agent name");
  const missingId = "9eac296c-4d60-4189-a0b5-ae71dd9c6ad9";
  const nameCollision = [
    {
      id: "c9a97e5d-4a92-4646-a016-53032146d0a1",
      title: `worker ${missingId}`,
    },
  ];
  assert.strictEqual(resolveAgentId(missingId, nameCollision), null);
  console.log("✓ missing full UUID does not match another agent name\n");
}

{
  console.log("Test 4: ID prefix resolves");
  assert.strictEqual(resolveAgentId("def5678", agents), "def5678-other-agent-id");
  console.log("✓ ID prefix resolves\n");
}

{
  console.log("Test 5: exact name match resolves case-insensitively");
  assert.strictEqual(resolveAgentId("fix archive flow", agents), "def5678-other-agent-id");
  console.log("✓ exact name match resolves case-insensitively\n");
}

{
  console.log("Test 6: partial name match resolves when unique");
  assert.strictEqual(resolveAgentId("review", agents), "987zyxw-third-agent-id");
  console.log("✓ partial name match resolves when unique\n");
}

{
  console.log("Test 7: missing agent returns null");
  assert.strictEqual(resolveAgentId("does not exist", agents), null);
  console.log("✓ missing agent returns null\n");
}

console.log("=== All agent ID resolution tests passed ===");
