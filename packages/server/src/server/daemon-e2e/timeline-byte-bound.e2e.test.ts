import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { TIMELINE_PAGE_BYTE_BUDGET } from "../websocket/physical-socket.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// The server enforces the budget on the projection entries; the wire response adds a
// per-entry `provider` field the budget measurement does not count, so strip it to
// compare on the same basis the bound is applied.
function projectedPageBytes(entries: ReadonlyArray<{ provider?: string }>): number {
  return Buffer.byteLength(
    JSON.stringify(entries.map(({ provider: _provider, ...entry }) => entry)),
  );
}

// ~40 KiB per entry x 400 entries ≈ 16 MiB of projected content — well over the 4 MiB
// page budget. Distinct completed tool_calls stay separate projected entries (no assistant
// merge), and `unknown` detail output is not source-capped.
async function appendLargeTimeline(
  ctx: DaemonTestContext,
  agentId: string,
  count: number,
  prefix = "call",
): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    await ctx.daemon.daemon.agentManager.appendTimelineItem(agentId, {
      type: "tool_call",
      callId: `${prefix}_${i}`,
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: { i }, output: { data: "y".repeat(40 * 1024) } },
    });
  }
}

describe("daemon E2E - timeline byte bound (#2610)", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("opening a large timeline returns a bounded tail page and still pages the full history", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Byte bound test",
        modeId: "full-access",
      });
      await appendLargeTimeline(ctx, agent.id, 400);

      const tail = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 400,
        projection: "projected",
      });

      // (a) bounded: the ~16 MiB timeline comes back as a page under budget with fewer than
      // all entries, and (b) more is available older — without bounding the whole timeline
      // would arrive in one frame (all 400 entries).
      expect(tail.entries.length).toBeGreaterThan(0);
      expect(tail.entries.length).toBeLessThan(400);
      expect(tail.hasOlder).toBe(true);
      expect(projectedPageBytes(tail.entries)).toBeLessThanOrEqual(TIMELINE_PAGE_BYTE_BUDGET);

      // (d)+(e) forward progress + bounded-not-partial: page from the start forward with
      // `after`; endCursor strictly advances; the union reproduces the full committed set.
      const seen = new Set<number>();
      let cursor = { epoch: tail.startCursor!.epoch, seq: 0 };
      let guard = 0;
      for (;;) {
        const page = await ctx.client.fetchAgentTimeline(agent.id, {
          direction: "after",
          cursor,
          limit: 400,
          projection: "projected",
        });
        expect(page.entries.length).toBeGreaterThan(0); // never a zero-entry hasNewer page
        for (const entry of page.entries) seen.add(entry.seqEnd);
        expect(page.endCursor!.seq).toBeGreaterThan(cursor.seq); // strictly advances
        cursor = { epoch: page.endCursor!.epoch, seq: page.endCursor!.seq };
        if (!page.hasNewer) break;
        guard += 1;
        expect(guard).toBeLessThan(50); // catch a stall
      }
      expect(seen.size).toBe(400);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("bounds a page around a wide entry instead of re-expanding over its whole span", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Wide entry bound test",
        modeId: "full-access",
      });

      // Layout (oldest -> newest): a tool that stays running across a ~7 MiB region
      // (175 large entries), then completes, then ~50 independent large entries
      // (~2 MiB) that are newer than its completion. The completed tool collapses
      // into one projected entry whose source span covers the whole 7 MiB region.
      //
      // A byte fit that reduced a pre-expansion item count would land inside that
      // span; re-selecting that limit re-expands the window back over the full 7 MiB
      // region (plus the 2 MiB tail) — ~9 MiB, blowing the 4 MiB budget wide open (and
      // for a larger history, past the 64 MiB socket backstop / relay caps). Enforcing
      // the budget on the *selected* page instead finds the newest window that excludes
      // the wide entry, so the tail stays bounded and the wide region is reachable via
      // older pages.
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "tool_call",
        callId: "wide",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "unknown", input: { cmd: "watch" }, output: null },
      });
      await appendLargeTimeline(ctx, agent.id, 175, "region");
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "tool_call",
        callId: "wide",
        name: "shell",
        status: "completed",
        error: null,
        detail: {
          type: "unknown",
          input: { cmd: "watch" },
          output: { data: "z".repeat(40 * 1024) },
        },
      });
      await appendLargeTimeline(ctx, agent.id, 50, "newest");

      const tail = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 400,
        projection: "projected",
      });

      // The wide entry and its ~7 MiB region are excluded from the tail page (only the
      // ~50 newest independent entries fit the budget) and remain reachable as older —
      // without the selected-page bound this frame would carry the whole ~9 MiB span.
      expect(tail.entries.length).toBeGreaterThan(0);
      expect(tail.entries.length).toBeLessThan(100);
      expect(tail.hasOlder).toBe(true);
      expect(projectedPageBytes(tail.entries)).toBeLessThanOrEqual(TIMELINE_PAGE_BYTE_BUDGET);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
