import type { SessionMessageAssistant } from "@opencode/client";
import { expect, test } from "vitest";
import { V2Timeline } from "./timeline.js";

test("completed v2 edits retain the patch from filediff metadata", () => {
  const patch = "@@ -1 +1 @@\n-before\n+after";
  const message: SessionMessageAssistant = {
    id: "message",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "call",
        name: "edit",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: { filePath: "/workspace/file.ts" },
          content: [{ type: "text", text: "Edit applied successfully." }],
          metadata: {
            diff: "@@ -1 +1 @@\n-stale\n+fallback",
            filediff: { patch, additions: 1, deletions: 1 },
          },
        },
      },
    ],
  };

  expect(new V2Timeline().messages([message])).toMatchObject([
    {
      item: {
        type: "tool_call",
        callId: "call",
        status: "completed",
        detail: { type: "edit", filePath: "/workspace/file.ts", unifiedDiff: patch },
      },
    },
  ]);
});

test("v2 edits fall back to metadata diff, then input strings", () => {
  const message: SessionMessageAssistant = {
    id: "message",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "metadata-diff",
        name: "edit",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: { filePath: "/workspace/file.ts", oldString: "before", newString: "after" },
          content: [{ type: "text", text: "Edit applied successfully." }],
          metadata: { diff: "@@ -1 +1 @@\n-before\n+after" },
        },
      },
      {
        type: "tool",
        id: "input-only",
        name: "edit",
        time: { created: 2, completed: 3 },
        state: {
          status: "completed",
          input: { filePath: "/workspace/other.ts", oldString: "old", newString: "new" },
          content: [{ type: "text", text: "Edit applied successfully." }],
        },
      },
    ],
  };

  expect(new V2Timeline().messages([message])).toMatchObject([
    {
      item: {
        detail: {
          type: "edit",
          filePath: "/workspace/file.ts",
          oldString: "before",
          newString: "after",
          unifiedDiff: "@@ -1 +1 @@\n-before\n+after",
        },
      },
    },
    {
      item: {
        detail: {
          type: "edit",
          filePath: "/workspace/other.ts",
          oldString: "old",
          newString: "new",
        },
      },
    },
  ]);
});
