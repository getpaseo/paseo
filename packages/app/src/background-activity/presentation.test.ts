import { expect, it } from "vitest";
import { projectBackgroundRows } from "./presentation";
import { panelResourceKey, panelSupportsHost } from "@/panels/panel-manifest";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";

it("projects standard messages and links each request to its own prompt", () => {
  const result = projectBackgroundRows(
    [
      {
        seq: 1,
        requestId: "first",
        attemptId: "a",
        timestamp: 1000,
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "user_message", messageId: "a", text: "First prompt" },
        },
      },
      {
        seq: 2,
        requestId: "first",
        attemptId: "a",
        timestamp: 1100,
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: '{"description":"Read plan"}' },
        },
      },
      {
        seq: 3,
        requestId: "second",
        attemptId: "b",
        timestamp: 1200,
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "user_message", messageId: "b", text: "Second prompt" },
        },
      },
    ],
    "epoch",
  );
  expect(result.items).toHaveLength(3);
  expect(result.prompts.get("first")).toBe(result.items[0].id);
  expect(result.prompts.get("second")).toBe(result.items[2].id);
});

it("keeps the list in Explorer and reuses a main thread while changing its requested scroll position", () => {
  const first = {
    kind: "background_thread",
    conversationId: "helper",
    requestId: "first",
  } as const;
  const second = { ...first, requestId: "second" };
  expect(panelResourceKey(first)).toBe(panelResourceKey(second));
  expect(workspaceTabTargetsEqual(first, second)).toBe(false);
  expect(panelSupportsHost("background_activity", "explorer")).toBe(true);
  expect(panelSupportsHost("background_activity", "main")).toBe(false);
  expect(panelSupportsHost("background_thread", "main")).toBe(true);
  expect(panelSupportsHost("background_thread", "explorer")).toBe(false);
});
