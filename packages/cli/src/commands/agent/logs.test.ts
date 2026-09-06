import { afterEach, describe, expect, it, vi } from "vitest";

import { runLogsCommand, selectTimelineItemsForJson } from "./logs.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "idle",
  archivedAt: null,
  cwd: "/tmp/project",
};

const fixtures = vi.hoisted(() => {
  const toolCall = {
    type: "tool_call",
    callId: "call-1",
    name: "shell",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "echo third", output: "third", exitCode: 0 },
  };
  const items = [
    { type: "user_message", text: "first" },
    { type: "assistant_message", text: "second" },
    toolCall,
  ];
  return { items, toolCall };
});

const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgent: vi.fn(async () => ({ agent })),
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

vi.mock("../../utils/timeline.js", () => ({
  fetchProjectedTimelineItems: vi.fn(async () => fixtures.items),
  LIVE_HISTORY_FETCH_TIMEOUT_MS: 1_000,
}));

const timelineItems = fixtures.items as unknown as AgentTimelineItem[];

function captureStdout(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    written.push(String(value));
  });
  return { lines: () => written, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectTimelineItemsForJson", () => {
  it("returns every item when no tail is requested", () => {
    expect(selectTimelineItemsForJson(timelineItems)).toEqual(timelineItems);
  });

  it("returns the last n items, matching the transcript's maxItems slice", () => {
    expect(selectTimelineItemsForJson(timelineItems, 2)).toEqual(timelineItems.slice(-2));
  });

  it("returns nothing for a zero tail", () => {
    expect(selectTimelineItemsForJson(timelineItems, 0)).toEqual([]);
  });

  it("returns every item when the tail exceeds the timeline length", () => {
    expect(selectTimelineItemsForJson(timelineItems, 99)).toEqual(timelineItems);
  });
});

describe("runLogsCommand with --json", () => {
  it("emits the timeline as parseable JSON instead of the text transcript", async () => {
    const stdout = captureStdout();

    await runLogsCommand(agent.id, { json: true }, {} as never);

    const output = stdout.lines().join("\n");
    stdout.restore();

    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toEqual(timelineItems);
  });

  it("applies --tail to the JSON payload", async () => {
    const stdout = captureStdout();

    await runLogsCommand(agent.id, { json: true, tail: "2" }, {} as never);

    const parsed = JSON.parse(stdout.lines().join("\n"));
    stdout.restore();

    expect(parsed).toEqual(timelineItems.slice(-2));
  });

  it("applies --filter to the JSON payload", async () => {
    const stdout = captureStdout();

    await runLogsCommand(agent.id, { json: true, filter: "tools" }, {} as never);

    const parsed = JSON.parse(stdout.lines().join("\n"));
    stdout.restore();

    expect(parsed).toEqual([fixtures.toolCall]);
  });

  it("still prints the text transcript when --json is absent", async () => {
    const stdout = captureStdout();

    await runLogsCommand(agent.id, {}, {} as never);

    const output = stdout.lines().join("\n");
    stdout.restore();

    expect(() => JSON.parse(output)).toThrow();
    expect(output).toContain("second");
  });
});
