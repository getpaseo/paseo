import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HandoffPinger, isQuietHour, type HandoffPingInput } from "./handoff-ping.js";

const DAY = new Date("2026-09-30T12:00:00.000Z"); // 14:00 in Berlin
const NIGHT = new Date("2026-09-30T21:30:00.000Z"); // 23:30 in Berlin

function input(overrides: Partial<HandoffPingInput> = {}): HandoffPingInput {
  return {
    serverId: "srv",
    workspaceId: "wks",
    projectName: "RateMyCoworking",
    lastUserMessageAt: null,
    handoff: {
      agentId: "agent",
      kind: "action",
      need: "Bitte bei Supabase anmelden, damit es weitergeht.",
      at: DAY.toISOString(),
    },
    ...overrides,
  };
}

function pinger(now: Date) {
  const deliver = vi.fn(async () => {});
  const sendMorningSummary = vi.fn(async () => {});
  let morning: (() => void) | null = null;
  const instance = new HandoffPinger({
    deliver,
    sendMorningSummary,
    logger: pino({ level: "silent" }),
    now: () => now,
    setTimer: (run) => {
      morning = run;
      return 0 as never;
    },
  });
  return { instance, deliver, sendMorningSummary, runMorning: () => morning?.() };
}

describe("HandoffPinger", () => {
  it("pings a question or action once with the project and the agent's sentence", () => {
    const { instance, deliver } = pinger(DAY);
    instance.notify(input());
    instance.notify(input());
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({
      agentId: "agent",
      title: "RateMyCoworking",
      body: "Bitte bei Supabase anmelden, damit es weitergeht.",
      data: { serverId: "srv", workspaceId: "wks", agentId: "agent", reason: "finished" },
    });
  });

  it("pings again only after the person answered, and never for reports or stops", () => {
    const { instance, deliver } = pinger(DAY);
    instance.notify(input());
    instance.notify(input({ lastUserMessageAt: new Date(DAY.getTime() + 60_000) }));
    expect(deliver).toHaveBeenCalledTimes(2);

    for (const kind of ["report", "aborted", "unsure"] as const) {
      instance.notify(input({ workspaceId: kind, handoff: { ...input().handoff, kind } }));
    }
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("holds night pings for one morning summary", async () => {
    const { instance, deliver, sendMorningSummary, runMorning } = pinger(NIGHT);
    instance.notify(input({ workspaceId: "a", projectName: "A" }));
    instance.notify(input({ workspaceId: "b", projectName: "B" }));
    expect(deliver).not.toHaveBeenCalled();

    runMorning();
    await vi.waitFor(() => expect(sendMorningSummary).toHaveBeenCalledTimes(1));
    expect(sendMorningSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "2 sessions wait for you",
        body: expect.stringContaining("A: Bitte bei Supabase anmelden"),
      }),
    );
  });

  it("treats 22:00 to 07:00 Berlin time as night", () => {
    const quiet = { from: 22, to: 7 };
    expect(isQuietHour(new Date("2026-09-30T20:30:00.000Z"), "Europe/Berlin", quiet)).toBe(true);
    expect(isQuietHour(new Date("2026-10-01T04:59:00.000Z"), "Europe/Berlin", quiet)).toBe(true);
    expect(isQuietHour(new Date("2026-10-01T05:00:00.000Z"), "Europe/Berlin", quiet)).toBe(false);
    expect(isQuietHour(DAY, "Europe/Berlin", quiet)).toBe(false);
  });
});
