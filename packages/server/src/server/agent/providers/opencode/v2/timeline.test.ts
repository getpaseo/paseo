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

test("v2 edits read the matching files patch with its unified headers and hunk", () => {
  const patch = [
    "Index: /tmp/a.txt",
    "===================================================================",
    "--- /tmp/a.txt",
    "+++ /tmp/a.txt",
    "@@ -1,4 +1,4 @@",
    " line one",
    "-line two",
    "+line 2 changed",
    " line three",
    " line four",
    "\\ No newline at end of file",
    "",
  ].join("\n");
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
          input: { filePath: "/tmp/a.txt" },
          content: [{ type: "text", text: "Edit applied successfully." }],
          metadata: {
            files: [{ file: "/tmp/a.txt", patch, status: "modified", additions: 1, deletions: 1 }],
            truncated: false,
          },
        },
      },
    ],
  };

  expect(new V2Timeline().messages([message])).toMatchObject([
    {
      item: {
        detail: {
          type: "edit",
          filePath: "/tmp/a.txt",
          unifiedDiff: [
            "--- /tmp/a.txt",
            "+++ /tmp/a.txt",
            "@@ -1,4 +1,4 @@",
            " line one",
            "-line two",
            "+line 2 changed",
            " line three",
            " line four",
          ].join("\n"),
        },
      },
    },
  ]);
});

function editDetail(metadata: Record<string, unknown>, filePath = "/tmp/a.txt") {
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
          input: { filePath, oldString: "before", newString: "after" },
          content: [{ type: "text", text: "Edit applied successfully." }],
          metadata,
        },
      },
    ],
  };
  const event = new V2Timeline().messages([message])[0];
  if (event?.type !== "timeline" || event.item.type !== "tool_call") {
    throw new Error("Expected edit tool call");
  }
  return event.item.detail;
}

test("v2 edits choose the matching file over other files and older metadata shapes", () => {
  expect(
    editDetail({
      files: [
        { file: "/tmp/b.txt", patch: "@@ -1 +1 @@\n-wrong\n+wrong" },
        { file: "/tmp/a.txt", patch: "@@ -1 +1 @@\n-before\n+after" },
      ],
      filediff: { patch: "@@ -1 +1 @@\n-stale\n+stale" },
      diff: "@@ -1 +1 @@\n-old\n+old",
    }),
  ).toEqual({
    type: "edit",
    filePath: "/tmp/a.txt",
    oldString: "before",
    newString: "after",
    unifiedDiff: "@@ -1 +1 @@\n-before\n+after",
  });
  expect(
    editDetail({
      files: [
        { file: "/tmp/b.txt", patch: "@@ -1 +1 @@\n-wrong\n+wrong" },
        { file: "/tmp/c.txt", patch: "@@ -1 +1 @@\n-wrong\n+wrong" },
      ],
    }),
  ).toEqual({ type: "edit", filePath: "/tmp/a.txt", oldString: "before", newString: "after" });
});

test("v2 edits accept a sole file and fall through blank or hunk-less patches", () => {
  expect(
    editDetail({ files: [{ file: "/tmp/renamed.txt", patch: "@@ -1 +1 @@\n-before\n+after" }] }),
  ).toMatchObject({ unifiedDiff: "@@ -1 +1 @@\n-before\n+after" });
  expect(
    editDetail({
      files: [{ file: "/tmp/a.txt", patch: " " }],
      filediff: { patch: "@@ -1 +1 @@\n-before\n+filediff" },
      diff: "@@ -1 +1 @@\n-before\n+diff",
    }),
  ).toMatchObject({ unifiedDiff: "@@ -1 +1 @@\n-before\n+filediff" });
  expect(
    editDetail({
      files: [{ file: "/tmp/a.txt", patch: "Index: /tmp/a.txt\n--- /tmp/a.txt\n+++ /tmp/a.txt" }],
      filediff: { patch: "no hunks" },
      diff: "@@ -1 +1 @@\n-before\n+diff",
    }),
  ).toMatchObject({ unifiedDiff: "@@ -1 +1 @@\n-before\n+diff" });
  expect(editDetail({ files: [{ file: "/tmp/a.txt", patch: "Index: /tmp/a.txt" }] })).toEqual({
    type: "edit",
    filePath: "/tmp/a.txt",
    oldString: "before",
    newString: "after",
  });
});
