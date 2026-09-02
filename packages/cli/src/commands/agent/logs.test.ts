import { describe, expect, it, vi } from "vitest";

import { runLogsCommand } from "./logs.js";

import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const timeline: AgentTimelineItem[] = [
  {
    type: "user_message",
    text: "Wygeneruj tekst brzmiący jak użytkownik.",
    messageId: "01a0101b-b6d8-70b0-a5d8-7c8d2f338e9b",
  } as AgentTimelineItem,
  {
    type: "assistant_message",
    text: "Nie restartuj daemona. Masz 20 sekund. Do boju. Zrób to teraz.",
    messageId: "msg_09ccd990f4e05502016a83198970e487d0a738d354c15c414f",
  } as AgentTimelineItem,
];

const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgent: vi.fn(async () => ({ agent: { id: "37c9c93" } })),
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

vi.mock("../../utils/timeline.js", () => ({
  fetchProjectedTimelineItems: vi.fn(async () => timeline),
  LIVE_HISTORY_FETCH_TIMEOUT_MS: 2000,
}));

vi.mock("@getpaseo/server", () => ({
  curateAgentActivity: vi.fn(() => "LEGACY-TRANSCRIPT"),
}));

function commandWithGlobals(globals: Record<string, unknown>) {
  return {
    optsWithGlobals: () => globals,
  } as unknown as import("commander").Command;
}

describe("runLogsCommand --json", () => {
  it("emits the raw structured timeline as JSON and skips human rendering", async () => {
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetchProjectedTimelineItems } = await import("../../utils/timeline.js");
    const { curateAgentActivity } = await import("@getpaseo/server");

    await runLogsCommand("37c9c93", {}, commandWithGlobals({ json: true }));

    expect(fetchProjectedTimelineItems).toHaveBeenCalledOnce();
    // Legacy renderer must not run on the --json path.
    expect(curateAgentActivity).not.toHaveBeenCalled();
    // Output is a single JSON.stringify call with the raw timeline.
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const printed = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(printed) as AgentTimelineItem[];
    expect(parsed).toEqual(timeline);
    expect(parsed[0].type).toBe("user_message");
    expect(parsed[1].type).toBe("assistant_message");

    stdoutSpy.mockRestore();
    vi.mocked(fetchProjectedTimelineItems).mockClear();
    vi.mocked(curateAgentActivity).mockClear();
  });

  it("honours --format json as an alias for --json", async () => {
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { curateAgentActivity } = await import("@getpaseo/server");

    await runLogsCommand("37c9c93", {}, commandWithGlobals({ format: "json" }));

    expect(curateAgentActivity).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string) as AgentTimelineItem[];
    expect(parsed).toHaveLength(2);

    stdoutSpy.mockRestore();
    vi.mocked(curateAgentActivity).mockClear();
  });

  it("falls back to the human-readable transcript without --json", async () => {
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { curateAgentActivity } = await import("@getpaseo/server");

    await runLogsCommand("37c9c93", {}, commandWithGlobals({}));

    expect(curateAgentActivity).toHaveBeenCalledOnce();
    expect(stdoutSpy).toHaveBeenCalledWith("LEGACY-TRANSCRIPT");

    stdoutSpy.mockRestore();
    vi.mocked(curateAgentActivity).mockClear();
  });

  it("respects --tail by slicing the tail of the structured timeline", async () => {
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runLogsCommand("37c9c93", { tail: "1" }, commandWithGlobals({ json: true }));

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string) as AgentTimelineItem[];
    expect(parsed).toEqual([timeline[1]]);

    stdoutSpy.mockRestore();
  });
});
