#!/usr/bin/env npx tsx

import assert from "node:assert";
import { rm } from "node:fs/promises";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

console.log("=== Chat Command Tests ===\n");

const ctx = await createE2ETestContext({ timeout: 30000 });

try {
  {
    console.log("Test 1: chat create/ls/inspect work");
    const created = await ctx.paseo(["chat", "create", "coord-room", "--purpose", "Coordination"]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    assert(created.stdout.includes("coord-room"), created.stdout);

    const listed = await ctx.paseo(["chat", "ls"]);
    assert.strictEqual(listed.exitCode, 0, listed.stderr);
    assert(listed.stdout.includes("coord-room"), listed.stdout);

    const inspected = await ctx.paseo(["chat", "inspect", "coord-room"]);
    assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
    assert(inspected.stdout.includes("Coordination"), inspected.stdout);
    console.log("chat create/ls/inspect work\n");
  }

  {
    console.log("Test 2: chat post/read/wait work");
    const posted = await ctx.paseo(["chat", "post", "coord-room", "first message for @agent-1"], {
      env: { PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000111" },
    });
    assert.strictEqual(posted.exitCode, 0, posted.stderr);
    assert(posted.stdout.includes("first message"), posted.stdout);
    assert(posted.stdout.includes("00000000-0000-4000-8000-000000000111"), posted.stdout);

    const read = await ctx.paseo(["chat", "read", "coord-room", "--limit", "10"]);
    assert.strictEqual(read.exitCode, 0, read.stderr);
    assert(read.stdout.includes("first message"), read.stdout);
    assert(read.stdout.includes("00000000-0000-4000-8000-000000000111"), read.stdout);

    const readJson = await ctx.paseo(["chat", "read", "coord-room", "--limit", "10", "--json"]);
    assert.strictEqual(readJson.exitCode, 0, readJson.stderr);
    const readPayload = JSON.parse(readJson.stdout);
    assert.strictEqual(readPayload[0]?.author, "00000000-0000-4000-8000-000000000111");

    const waitPromise = ctx.paseo(["chat", "wait", "coord-room", "--timeout", "5s"]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const secondPost = await ctx.paseo(["chat", "post", "coord-room", "second message"]);
    assert.strictEqual(secondPost.exitCode, 0, secondPost.stderr);

    const waited = await waitPromise;
    assert.strictEqual(waited.exitCode, 0, waited.stderr);
    assert(waited.stdout.includes("second message"), waited.stdout);
    console.log("chat post/read/wait work\n");
  }

  {
    console.log("Test 3: duplicate room create fails");
    const duplicate = await ctx.paseo(["chat", "create", "coord-room"]);
    assert.notStrictEqual(duplicate.exitCode, 0, "duplicate create should fail");
    const combined = `${duplicate.stdout}\n${duplicate.stderr}`;
    assert(combined.toLowerCase().includes("already exists"), combined);
    console.log("duplicate room create fails\n");
  }

  {
    console.log("Test 4: chat delete works");
    const deleted = await ctx.paseo(["chat", "delete", "coord-room"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    assert(deleted.stdout.includes("coord-room"), deleted.stdout);
    console.log("chat delete works\n");
  }
} finally {
  await ctx.stop();
  await rm(ctx.paseoHome, { recursive: true, force: true });
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("=== Chat Command Tests Passed ===");
