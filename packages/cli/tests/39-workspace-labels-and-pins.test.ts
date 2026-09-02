#!/usr/bin/env npx tsx

import assert from "node:assert";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

interface PinnedWorkspaceOutput {
  workspaceId: string;
  pinned: boolean;
  pinnedAt: string | null;
}

function parseWorkspaceId(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("workspaceId" in parsed) ||
    typeof parsed.workspaceId !== "string"
  ) {
    throw new Error("Workspace creation did not return a workspace id");
  }
  return parsed.workspaceId;
}

function parsePinnedWorkspace(stdout: string): PinnedWorkspaceOutput {
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("workspaceId" in parsed) ||
    typeof parsed.workspaceId !== "string" ||
    !("pinned" in parsed) ||
    typeof parsed.pinned !== "boolean" ||
    !("pinnedAt" in parsed) ||
    (typeof parsed.pinnedAt !== "string" && parsed.pinnedAt !== null)
  ) {
    throw new Error("Workspace pinning did not return a structured result");
  }
  return {
    workspaceId: parsed.workspaceId,
    pinned: parsed.pinned,
    pinnedAt: parsed.pinnedAt,
  };
}

console.log("=== Workspace Labels, Assignments, and Pins Commands ===\n");

const ctx = await createE2ETestContext({ timeout: 30000 });

try {
  const created = await ctx.paseo([
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    ctx.workDir,
    "--json",
  ]);
  assert.strictEqual(created.exitCode, 0, created.stderr);
  const workspaceId = parseWorkspaceId(created.stdout);

  const rawLabelName = "  Release   Candidate  ";
  const createdLabel = await ctx.paseo(["label", "create", rawLabelName, "--json"]);
  assert.strictEqual(createdLabel.exitCode, 0, createdLabel.stderr);
  assert.deepStrictEqual(JSON.parse(createdLabel.stdout), {
    name: "Release Candidate",
    color: "violet",
  });

  const labels = await ctx.paseo(["label", "ls", "--json"]);
  assert.strictEqual(labels.exitCode, 0, labels.stderr);
  assert.deepStrictEqual(JSON.parse(labels.stdout), [
    { name: "Release Candidate", color: "violet" },
  ]);

  const missingLabel = await ctx.paseo([
    "workspace",
    "label",
    "add",
    workspaceId,
    "Missing",
    "--json",
  ]);
  assert.notStrictEqual(missingLabel.exitCode, 0);
  assert.match(missingLabel.stderr, /LABEL_NOT_FOUND/);

  const addedLabel = await ctx.paseo([
    "workspace",
    "label",
    "add",
    workspaceId,
    "release candidate",
    "--json",
  ]);
  assert.strictEqual(addedLabel.exitCode, 0, addedLabel.stderr);
  assert.deepStrictEqual(JSON.parse(addedLabel.stdout), {
    workspaceId,
    label: "Release Candidate",
    assigned: true,
    workspaceLabels: ["Release Candidate"],
  });

  const removedLabel = await ctx.paseo([
    "workspace",
    "label",
    "remove",
    workspaceId,
    "RELEASE CANDIDATE",
    "--json",
  ]);
  assert.strictEqual(removedLabel.exitCode, 0, removedLabel.stderr);
  assert.deepStrictEqual(JSON.parse(removedLabel.stdout), {
    workspaceId,
    label: "Release Candidate",
    assigned: false,
    workspaceLabels: [],
  });

  const addedAgain = await ctx.paseo([
    "workspace",
    "label",
    "add",
    workspaceId,
    "Release Candidate",
    "--json",
  ]);
  assert.strictEqual(addedAgain.exitCode, 0, addedAgain.stderr);

  const duplicate = await ctx.paseo([
    "label",
    "create",
    "release candidate",
    "--color",
    "sky",
    "--json",
  ]);
  assert.notStrictEqual(duplicate.exitCode, 0);
  const duplicateError: unknown = JSON.parse(duplicate.stderr);
  assert.deepStrictEqual(duplicateError, {
    error: {
      code: "label_name_taken",
      message: "Failed to create workspace label: A label with that name already exists",
    },
  });
  assert.doesNotMatch(duplicate.stderr, /requestType=/);

  const invalidColor = await ctx.paseo([
    "label",
    "create",
    "Another label",
    "--color",
    "chartreuse",
    "--json",
  ]);
  assert.notStrictEqual(invalidColor.exitCode, 0);
  assert.match(invalidColor.stderr, /INVALID_LABEL_COLOR/);

  const pinned = await ctx.paseo(["workspace", "pin", workspaceId, "--json"]);
  assert.strictEqual(pinned.exitCode, 0, pinned.stderr);
  const pinnedData = parsePinnedWorkspace(pinned.stdout);
  assert.deepStrictEqual(pinnedData.workspaceId, workspaceId);
  assert.strictEqual(pinnedData.pinned, true);
  if (typeof pinnedData.pinnedAt !== "string") {
    throw new Error("Pin did not return a timestamp");
  }
  assert.match(pinnedData.pinnedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  const unpinned = await ctx.paseo(["workspace", "unpin", workspaceId, "--json"]);
  assert.strictEqual(unpinned.exitCode, 0, unpinned.stderr);
  assert.deepStrictEqual(JSON.parse(unpinned.stdout), {
    workspaceId,
    pinned: false,
    pinnedAt: null,
  });

  const deleted = await ctx.paseo(["label", "delete", "release candidate", "--json"]);
  assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
  assert.deepStrictEqual(JSON.parse(deleted.stdout), {
    name: "Release Candidate",
    affectedWorkspaceCount: 1,
  });

  const deletedAgain = await ctx.paseo(["label", "delete", "Release Candidate", "--json"]);
  assert.strictEqual(deletedAgain.exitCode, 0, deletedAgain.stderr);
  assert.deepStrictEqual(JSON.parse(deletedAgain.stdout), {
    name: "Release Candidate",
    affectedWorkspaceCount: 0,
  });

  const remaining = await ctx.paseo(["label", "ls", "--json"]);
  assert.strictEqual(remaining.exitCode, 0, remaining.stderr);
  assert.deepStrictEqual(JSON.parse(remaining.stdout), []);

  const unsafeName = "Unsafe\u001b]0;owned\u0007\u009b31m";
  const unsafeCreated = await ctx.paseo(["label", "create", unsafeName, "--json"]);
  assert.strictEqual(unsafeCreated.exitCode, 0, unsafeCreated.stderr);
  assert.deepStrictEqual(JSON.parse(unsafeCreated.stdout), { name: unsafeName, color: "violet" });
  assert.strictEqual(unsafeCreated.stdout.includes("\u009b"), false);
  const quietLabels = await ctx.paseo(["label", "ls", "--quiet"]);
  assert.strictEqual(quietLabels.exitCode, 0, quietLabels.stderr);
  assert.strictEqual(quietLabels.stdout.trim(), "Unsafe\\u001b]0;owned\\u0007\\u009b31m");
  assert.strictEqual(quietLabels.stdout.includes("\u001b"), false);
  assert.strictEqual(quietLabels.stdout.includes("\u0007"), false);
  assert.strictEqual(quietLabels.stdout.includes("\u009b"), false);
} finally {
  await ctx.stop();
}

console.log("=== Workspace Labels, Assignments, and Pins Command Tests Passed ===");
