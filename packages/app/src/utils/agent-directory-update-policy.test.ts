import { describe, expect, it } from "vitest";

import { acceptAgentDirectoryUpdate } from "./agent-directory-update-policy";

interface TestAgent {
  updatedAt: Date;
  lastUsage?: { inputTokens?: number; outputTokens?: number };
  activeTurn?: { turnId: string | null } | null;
  activeTurnOutputTokens?: number;
  activeTurnIdleMs?: number;
  activeTurnIdleReceivedAt?: Date;
  marker?: string;
}

const OLDER = new Date("2026-07-30T12:00:00.000Z");
const NEWER = new Date("2026-07-30T12:00:05.000Z");

describe("acceptAgentDirectoryUpdate", () => {
  it("takes the incoming record when there is nothing to compare against", () => {
    const incoming: TestAgent = { updatedAt: OLDER, marker: "incoming" };

    expect(acceptAgentDirectoryUpdate(undefined, incoming)).toBe(incoming);
  });

  it("takes the incoming record when it is at least as new", () => {
    const current: TestAgent = { updatedAt: OLDER, marker: "current" };
    const incoming: TestAgent = { updatedAt: NEWER, marker: "incoming" };

    expect(acceptAgentDirectoryUpdate(current, incoming)).toBe(incoming);
  });

  it("keeps the current record when a stale update carries no usage", () => {
    const current: TestAgent = { updatedAt: NEWER, marker: "current" };
    const incoming: TestAgent = { updatedAt: OLDER, marker: "stale" };

    expect(acceptAgentDirectoryUpdate(current, incoming)).toBe(current);
  });

  it("grafts usage forward from a stale update", () => {
    const current: TestAgent = { updatedAt: NEWER, marker: "current" };
    const incoming: TestAgent = { updatedAt: OLDER, lastUsage: { inputTokens: 10 } };

    const result = acceptAgentDirectoryUpdate(current, incoming);

    expect(result.marker).toBe("current");
    expect(result.lastUsage).toEqual({ inputTokens: 10 });
  });

  // A stale update must never write live turn progress forward. The `updatedAt` ordering above
  // already guarantees the record we hold was projected later, and the daemon rebuilds all three
  // progress fields from live state on every running snapshot — so anything an older record
  // carries is equal or worse. These pin that, because the tempting shape (carry it when both
  // records name the same turn) reads correct and is not.
  describe("live turn progress is never grafted from a stale update", () => {
    it("does not let a stale same-turn count lower the one on screen", () => {
      const current: TestAgent = {
        updatedAt: NEWER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 250,
        activeTurnIdleMs: 1_000,
      };
      const incoming: TestAgent = {
        updatedAt: OLDER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 100,
        activeTurnIdleMs: 5_000,
      };

      const result = acceptAgentDirectoryUpdate(current, incoming);

      expect(result.activeTurnOutputTokens).toBe(250);
      expect(result.activeTurnIdleMs).toBe(1_000);
    });

    it("does not resurrect a count the current record has already cleared", () => {
      // A provider that stops reporting mid-turn clears the slot. A late record from the same
      // turn still carries the old number, and grafting it would freeze a dead count on screen.
      const current: TestAgent = { updatedAt: NEWER, activeTurn: { turnId: "turn-7" } };
      const incoming: TestAgent = {
        updatedAt: OLDER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 100,
      };

      expect(acceptAgentDirectoryUpdate(current, incoming).activeTurnOutputTokens).toBeUndefined();
    });

    it("does not replace the idle duration or the instant it was measured", () => {
      // These two move together or not at all: the client adds elapsed-since-receipt to the
      // duration, so a stale pair reports silence that the newer record already contradicted.
      const currentReceivedAt = new Date("2026-07-30T12:00:04.000Z");
      const current: TestAgent = {
        updatedAt: NEWER,
        activeTurn: { turnId: "turn-7" },
        activeTurnIdleMs: 0,
        activeTurnIdleReceivedAt: currentReceivedAt,
      };
      const incoming: TestAgent = {
        updatedAt: OLDER,
        activeTurn: { turnId: "turn-7" },
        activeTurnIdleMs: 120_000,
        activeTurnIdleReceivedAt: new Date("2026-07-30T12:00:01.000Z"),
      };

      const result = acceptAgentDirectoryUpdate(current, incoming);

      expect(result.activeTurnIdleMs).toBe(0);
      expect(result.activeTurnIdleReceivedAt).toBe(currentReceivedAt);
    });

    it("leaves the current count untouched when the turns differ", () => {
      const current: TestAgent = {
        updatedAt: NEWER,
        activeTurn: { turnId: "turn-8" },
        activeTurnOutputTokens: 12,
      };
      const incoming: TestAgent = {
        updatedAt: OLDER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 9_999,
      };

      expect(acceptAgentDirectoryUpdate(current, incoming).activeTurnOutputTokens).toBe(12);
    });

    it("keeps progress when a stale update grafts usage forward", () => {
      // The one thing a stale record may still contribute is `lastUsage`. Doing so must not
      // disturb the progress fields riding on the record it is merged into.
      const current: TestAgent = {
        updatedAt: NEWER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 250,
      };
      const incoming: TestAgent = {
        updatedAt: OLDER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 100,
        lastUsage: { inputTokens: 10 },
      };

      const result = acceptAgentDirectoryUpdate(current, incoming);

      expect(result.lastUsage).toEqual({ inputTokens: 10 });
      expect(result.activeTurnOutputTokens).toBe(250);
    });

    it("does not allocate a new record when a stale update carries only progress", () => {
      const current: TestAgent = {
        updatedAt: NEWER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 250,
      };
      const incoming: TestAgent = {
        updatedAt: OLDER,
        activeTurn: { turnId: "turn-7" },
        activeTurnOutputTokens: 100,
      };

      expect(acceptAgentDirectoryUpdate(current, incoming)).toBe(current);
    });
  });
});
