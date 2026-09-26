import { describe, expect, test } from "vitest";

import type { MuseViewItem } from "./items.js";
import { mapMuseToolCall, mapMuseToolStatus } from "./tools.js";

function toolItem(overrides: Partial<MuseViewItem> = {}): MuseViewItem {
  return {
    itemId: "item-1",
    revision: 1,
    kind: "toolCall",
    turnId: "turn-1",
    status: "completed",
    tool: "read_file",
    callId: "call-1",
    args: JSON.stringify({ path: "/tmp/a.txt" }),
    visibleOutput: "contents",
    ...overrides,
  };
}

describe("mapMuseToolStatus", () => {
  test("maps MSP statuses to timeline statuses", () => {
    expect(mapMuseToolStatus("completed")).toBe("completed");
    expect(mapMuseToolStatus("failed")).toBe("failed");
    expect(mapMuseToolStatus("rejected")).toBe("failed");
    expect(mapMuseToolStatus("timedOut")).toBe("failed");
    expect(mapMuseToolStatus("cancelled")).toBe("canceled");
    expect(mapMuseToolStatus("inProgress")).toBe("running");
    expect(mapMuseToolStatus("something-new")).toBe("running");
  });
});

describe("mapMuseToolCall", () => {
  test("maps read tools with file detail", () => {
    const item = mapMuseToolCall(toolItem());

    expect(item).toMatchObject({
      type: "tool_call",
      callId: "call-1",
      name: "read_file",
      status: "completed",
      detail: { type: "read", filePath: "/tmp/a.txt", content: "contents" },
    });
  });

  test("maps shell tools with command detail", () => {
    const item = mapMuseToolCall(
      toolItem({
        tool: "shell_exec",
        args: JSON.stringify({ command: "ls -la", cwd: "/tmp" }),
      }),
    );

    expect(item.detail).toMatchObject({
      type: "shell",
      command: "ls -la",
      cwd: "/tmp",
      output: "contents",
    });
  });

  test("maps edit tools with diff detail", () => {
    const item = mapMuseToolCall(
      toolItem({
        tool: "edit_file",
        args: JSON.stringify({ path: "/tmp/a.txt", oldString: "a", newString: "b" }),
        patchSummary: "@@ -1 +1 @@",
      }),
    );

    expect(item.detail).toMatchObject({
      type: "edit",
      filePath: "/tmp/a.txt",
      oldString: "a",
      newString: "b",
      unifiedDiff: "@@ -1 +1 @@",
    });
  });

  test("falls back to plain text, then unknown", () => {
    const plain = mapMuseToolCall(toolItem({ tool: "mystery", args: "not json" }));
    expect(plain.detail).toMatchObject({ type: "plain_text", label: "mystery" });

    const unknown = mapMuseToolCall(
      toolItem({ tool: "mystery", args: "not json", visibleOutput: "" }),
    );
    expect(unknown.detail).toMatchObject({ type: "unknown" });
  });

  test("failed calls carry the provider reason", () => {
    const item = mapMuseToolCall(
      toolItem({ status: "failed", failureReason: "denied by policy" }),
    );

    expect(item.status).toBe("failed");
    expect(item.error).toMatchObject({ message: "denied by policy" });
  });

  test("running calls use the item id when no call id exists", () => {
    const item = mapMuseToolCall(toolItem({ status: "inProgress", callId: undefined }));

    expect(item).toMatchObject({ status: "running", callId: "item-1", error: null });
  });
});
