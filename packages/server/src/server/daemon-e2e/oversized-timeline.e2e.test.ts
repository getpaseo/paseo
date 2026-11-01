import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";

// #2220: a timeline page is one WebSocket message, so a few huge entries used to close the socket.
test.each([40, 0])(
  "fetching image-heavy history with limit %i keeps the direct connection usable",
  async (limit) => {
    const ctx = await createDaemonTestContext();
    const cwd = mkdtempSync(path.join(tmpdir(), "oversized-timeline-"));
    try {
      const agent = await ctx.client.createAgent({ provider: "codex", cwd });
      const imageUrl = `data:image/jpeg;base64,${"A".repeat(14 * 1024 * 1024)}`;
      for (let index = 0; index < 5; index += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "tool_call",
          callId: `screenshot-${index}`,
          name: "node_repl.js",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { index },
            output: { _meta: { "codex/toolSurface": { screenshot: { url: imageUrl } } } },
          },
        });
      }

      const page = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit });
      const screenshots = page.entries.filter((entry) => entry.item.type === "tool_call");
      expect(screenshots).toHaveLength(5);
      for (const entry of screenshots) {
        expect(Buffer.byteLength(JSON.stringify(entry.item))).toBeLessThanOrEqual(64 * 1024);
      }

      const next = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 1 });
      expect(next.entries).toHaveLength(1);
    } finally {
      await ctx.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);
