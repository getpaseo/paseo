import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const agentId = "11111111-1111-4111-8111-111111111111";
const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };
const timeline: AgentTimelineItem[] = [
  { type: "user_message", text: "say hi" },
  { type: "reasoning", text: "Greet the user." },
  { type: "assistant_message", text: "Hi!", messageId: "msg_1" },
];
const timelineEntries = timeline.map((item) => ({ item, timestamp: "2026-10-19T00:00:00.000Z" }));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgent: vi.fn(async () => ({ agent: { id: agentId } })),
    fetchAgentTimeline: vi.fn(async () => ({ entries: timelineEntries })),
    close: vi.fn(async () => undefined),
  })),
}));

import { runLogsCommand } from "./logs.js";

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    await run();
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

describe("paseo logs --json", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the timeline as JSON instead of the text transcript", async () => {
    const stdout = await captureStdout(() =>
      runLogsCommand("1111", { daemonTarget, json: true }, {} as Command),
    );

    expect(JSON.parse(stdout)).toEqual({ agentId, items: timeline });
  });

  it("applies --tail and --filter to the JSON items", async () => {
    const stdout = await captureStdout(() =>
      runLogsCommand(
        "1111",
        { daemonTarget, json: true, tail: "1", filter: "text" },
        {} as Command,
      ),
    );

    expect(JSON.parse(stdout)).toEqual({ agentId, items: [timeline[2]] });
  });

  it("still prints the text transcript without --json", async () => {
    const stdout = await captureStdout(() =>
      runLogsCommand("1111", { daemonTarget }, {} as Command),
    );

    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain("Hi!");
  });
});
