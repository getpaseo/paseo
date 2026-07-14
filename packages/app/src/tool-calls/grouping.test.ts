import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { compactToolCallRuns } from "./grouping";

function toolCall(
  id: string,
  detail: ToolCallDetail,
  options: {
    name?: string;
    status?: "running" | "completed" | "failed" | "canceled";
  } = {},
): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(`2026-01-01T00:00:${id.padStart(2, "0")}.000Z`),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: options.name ?? detail.type,
        status: options.status ?? "completed",
        error: options.status === "failed" ? "boom" : null,
        detail,
      },
    },
  };
}

function assistant(id: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: new Date("2026-01-01T00:01:00.000Z"),
  };
}

describe("compactToolCallRuns", () => {
  it("preserves the original arrays when compaction is disabled", () => {
    const tail = [toolCall("1", { type: "shell", command: "one" })];
    const head = [toolCall("2", { type: "shell", command: "two" })];

    const result = compactToolCallRuns({ tail, head, enabled: false });

    expect(result.tail).toBe(tail);
    expect(result.head).toBe(head);
    expect(result.groupsByHostId.size).toBe(0);
  });

  it("replaces four contiguous calls with a stable first-call host and latest timestamp", () => {
    const calls = [
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "shell", command: "two" }),
      toolCall("3", { type: "read", filePath: "/repo/src/a.ts" }),
      toolCall("4", { type: "edit", filePath: "/repo/src/a.ts" }),
    ];

    const result = compactToolCallRuns({ tail: calls, head: [], enabled: true });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toMatchObject({ id: "1", timestamp: calls[3]?.timestamp });
    expect(result.head).toEqual([]);
    expect(result.groupsByHostId.get("1")?.id).toBe("1");
    expect(result.groupsByHostId.get("1")?.calls).toEqual(calls);
    expect(result.groupsByHostId.get("1")).toMatchObject({
      editedFileCount: 1,
      commandCount: 2,
      readFileCount: 1,
      otherToolCount: 0,
      categories: [
        { key: "shell", label: "Shell", callCount: 2, resources: [] },
        { key: "read", label: "Read", callCount: 1, resources: ["a.ts"] },
        { key: "edit", label: "Edit", callCount: 1, resources: ["a.ts"] },
      ],
    });

    const nextCall = toolCall("5", { type: "shell", command: "five" }, { status: "running" });
    const updated = compactToolCallRuns({
      tail: [...calls, nextCall],
      head: [],
      enabled: true,
    });
    expect(updated.tail[0]).toMatchObject({ id: "1", timestamp: nextCall.timestamp });
    expect(updated.groupsByHostId.get("1")?.id).toBe("1");
  });

  it("does not compact short runs and stops at visible content boundaries", () => {
    const firstRun = [
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "shell", command: "two" }),
      toolCall("3", { type: "shell", command: "three" }),
    ];
    const boundary = assistant("assistant");
    const secondRun = [
      toolCall("4", { type: "read", filePath: "/repo/a.ts" }),
      toolCall("5", { type: "read", filePath: "/repo/b.ts" }),
      toolCall("6", { type: "read", filePath: "/repo/c.ts" }),
      toolCall("7", { type: "read", filePath: "/repo/d.ts" }),
    ];

    const result = compactToolCallRuns({
      tail: [...firstRun, boundary, ...secondRun],
      head: [],
      enabled: true,
    });

    expect(result.tail.slice(0, -1)).toEqual([...firstRun, boundary]);
    expect(result.tail.at(-1)).toMatchObject({ id: "4", timestamp: secondRun[3]?.timestamp });
    expect([...result.groupsByHostId.keys()]).toEqual(["4"]);
  });

  it("forms one group across the history and live-head boundary", () => {
    const tail = [
      assistant("assistant"),
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "shell", command: "two" }),
    ];
    const head = [
      toolCall("3", { type: "read", filePath: "/repo/a.ts" }),
      toolCall("4", { type: "edit", filePath: "/repo/a.ts" }, { status: "running" }),
    ];

    const result = compactToolCallRuns({ tail, head, enabled: true });

    expect(result.tail).toEqual([tail[0]]);
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({ id: "1", timestamp: head[1]?.timestamp });
    expect(result.groupsByHostId.get("1")?.calls).toEqual([...tail.slice(1), ...head]);
    expect(result.groupsByHostId.get("1")?.isRunning).toBe(true);
  });

  it("separates reads and searches from other tools", () => {
    const calls = [
      toolCall("1", { type: "read", filePath: "/repo/src/a.ts" }),
      toolCall("2", { type: "read", filePath: "C:\\repo\\src\\beta.ts" }),
      toolCall("3", { type: "fetch", url: "https://github.com/org/repo" }),
      toolCall(
        "4",
        { type: "search", query: "paseo", toolName: "web_search" },
        { status: "failed" },
      ),
      toolCall("5", { type: "fetch", url: "not a url" }),
    ];

    const result = compactToolCallRuns({ tail: calls, head: [], enabled: true });
    const group = result.groupsByHostId.get("1");

    expect(group).toMatchObject({
      failedCount: 1,
      isRunning: false,
      editedFileCount: 0,
      commandCount: 0,
      readFileCount: 2,
      searchCount: 1,
      otherToolCount: 2,
    });
  });

  it("counts unique edited files while counting each shell command", () => {
    const calls = [
      toolCall("1", { type: "edit", filePath: "/repo/a.ts" }),
      toolCall("2", { type: "edit", filePath: "/repo/a.ts" }),
      toolCall("3", { type: "write", filePath: "/repo/b.ts" }),
      toolCall("4", { type: "shell", command: "npm test" }),
      toolCall("5", { type: "shell", command: "npm run lint" }),
      toolCall("6", { type: "read", filePath: "/repo/c.ts" }),
    ];

    const result = compactToolCallRuns({ tail: calls, head: [], enabled: true });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      editedFileCount: 2,
      commandCount: 2,
      readFileCount: 1,
      otherToolCount: 0,
    });
  });

  it("counts Paseo calls separately from other tools", () => {
    const calls = [
      toolCall("1", { type: "unknown", input: null, output: null }, { name: "paseo.list_agents" }),
      toolCall(
        "2",
        { type: "unknown", input: null, output: null },
        { name: "mcp__paseo__list_worktrees" },
      ),
      toolCall("3", { type: "fetch", url: "https://paseo.sh" }),
      toolCall("4", { type: "fetch", url: "https://github.com/getpaseo" }),
    ];

    const result = compactToolCallRuns({ tail: calls, head: [], enabled: true });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      otherToolCount: 2,
      paseoCallCount: 2,
    });
  });

  it("classifies direct Brave and Paseo runtime tool names", () => {
    const unknownDetail = { type: "unknown" as const, input: null, output: null };
    const calls = [
      toolCall("1", unknownDetail, { name: "brave-search_brave_web_search" }),
      toolCall("2", unknownDetail, { name: "brave-search_brave_llm_context" }),
      toolCall("3", unknownDetail, { name: "paseo_list_providers" }),
      toolCall("4", unknownDetail, { name: "paseo_list_worktrees" }),
      toolCall("5", unknownDetail, { name: "paseo_list_worktrees" }),
      toolCall("6", unknownDetail, { name: "mcp__exa__web_search" }),
    ];

    const result = compactToolCallRuns({ tail: calls, head: [], enabled: true });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      searchCount: 3,
      otherToolCount: 0,
      paseoCallCount: 3,
    });
  });

  it("keeps plan and spoken-message calls outside compact groups", () => {
    const shellCalls = ["1", "2", "3", "4"].map((id) =>
      toolCall(id, { type: "shell", command: id }),
    );
    const plan = toolCall("5", { type: "plan", text: "Plan" });
    const speak = toolCall(
      "6",
      { type: "unknown", input: "Hello", output: null },
      { name: "speak" },
    );

    const result = compactToolCallRuns({
      tail: [...shellCalls, plan, speak],
      head: [],
      enabled: true,
    });

    expect(result.tail[0]).toMatchObject({ id: "1", timestamp: shellCalls[3]?.timestamp });
    expect(result.tail.slice(1)).toEqual([plan, speak]);
    expect(result.groupsByHostId.get("1")?.calls).toEqual(shellCalls);
  });

  it("deduplicates file resources by full path while displaying basenames", () => {
    const calls = [
      toolCall("1", { type: "read", filePath: "/repo/src/index.ts" }),
      toolCall("2", { type: "read", filePath: "/repo/tests/index.ts" }),
      toolCall("3", { type: "read", filePath: "/repo/src/other.ts" }),
      toolCall("4", { type: "read", filePath: "/repo/src/index.ts" }),
    ];

    const result = compactToolCallRuns({ tail: calls, head: [], enabled: true });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      readFileCount: 3,
      categories: [
        {
          key: "read",
          resources: ["index.ts", "index.ts", "other.ts"],
        },
      ],
    });
  });
});
