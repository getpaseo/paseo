import { randomUUID } from "node:crypto";
import {
  focusTerminalSurface,
  typeInTerminal,
  getTerminalBufferText,
} from "../support/helpers/terminal-perf";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { metroTest as test, expect, type Page } from "../support/fixtures";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import type { MockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  expectFoldedTurnAtReadingPosition,
  expectOldestLoadedTurnPartial,
  holdOlderHistoryPages,
  openAgentTimeline,
  expectTimelinePromptVisible,
  userScrollsTimelineToHistoryStart,
} from "../support/helpers/timeline-pagination";

interface PublishedDaemonAgent {
  serverId: string;
  daemon: Awaited<ReturnType<typeof startIsolatedHostDaemon>>;
  agent: MockAgentWorkspace;
  /** Register the host in the browser and apply app settings before the first load. */
  seedBrowser(page: Page, appSettings?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

async function startPublishedDaemonAgent(options: {
  publishedVersion: string;
  serverIdPrefix: string;
  repoPrefix: string;
  title: string;
}): Promise<PublishedDaemonAgent> {
  const serverId = `${options.serverIdPrefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const daemon = await startIsolatedHostDaemon(serverId, {
    publishedVersion: options.publishedVersion,
  });
  const workspace = await seedWorkspace({ repoPrefix: options.repoPrefix, port: daemon.port });
  const createdAgent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: options.title,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const agent: MockAgentWorkspace = {
    agentId: createdAgent.id,
    workspaceId: workspace.workspaceId,
    cwd: workspace.repoPath,
    client: workspace.client,
    cleanup: workspace.cleanup,
  };
  return {
    serverId,
    daemon,
    agent,
    async seedBrowser(page, appSettings) {
      const host = buildSeededHost({
        serverId,
        endpoint: `127.0.0.1:${daemon.port}`,
        nowIso: new Date().toISOString(),
      });
      await page.addInitScript(
        ({ seededHost, preferences, settings }) => {
          localStorage.setItem("@paseo:e2e", "1");
          localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
          localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
          if (settings) localStorage.setItem("@paseo:app-settings", JSON.stringify(settings));
        },
        { seededHost: host, preferences: buildCreateAgentPreferences(), settings: appSettings },
      );
    },
    async close() {
      await agent.cleanup();
      await daemon.close();
    },
  };
}

test("loads history across browser reconnection while retaining old-daemon connections and terminals", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const observationSockets = new Set<unknown>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (
        frame.type === "session" &&
        frame.message.type === "fetch_agents_request" &&
        frame.message.subscribe
      )
        observationSockets.add(socket);
    });
  });
  const published = await startPublishedDaemonAgent({
    publishedVersion: "0.2.5",
    serverIdPrefix: "srv_old_pagination_",
    repoPrefix: "timeline-old-daemon-pagination-",
    title: "Published daemon pagination regression",
  });
  const { agent, serverId } = published;

  try {
    await agent.client.sendAgentMessage(agent.agentId, "emit 1 coalesced agent stream updates");
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await published.seedBrowser(page);

    await openAgentTimeline(page, agent, serverId);
    await expectTimelinePromptVisible(page, "emit 1 coalesced agent stream updates");
    expect(observationSockets.size).toBe(1);

    await test.step("reconnect the browser and reload the old daemon history", async () => {
      observationSockets.clear();
      await page.reload();
      await expectTimelinePromptVisible(page, "emit 1 coalesced agent stream updates");
      await expect.poll(() => observationSockets.size).toBe(1);
    });

    await test.step("open a terminal and receive its output", async () => {
      const terminal = await agent.client.createTerminal(agent.cwd, "Compatibility terminal");
      expect(terminal.error).toBeNull();
      const terminalId = terminal.terminal!.id;
      const route = buildHostWorkspaceRoute(serverId, agent.workspaceId);
      await page.goto(`${route}?open=${encodeURIComponent(`terminal:${terminalId}`)}`);
      await focusTerminalSurface(page);
      await typeInTerminal(page, "printf 'compatibility-%s\\n' terminal-output\n");
      await expect
        .poll(() => getTerminalBufferText(page), { timeout: 15_000 })
        .toContain("compatibility-terminal-output");
      await agent.client.killTerminal(terminalId);
    });
  } finally {
    await published.close();
  }
});

// Hosts without whole-turn pages split turns across item pages. The oldest loaded turn
// starts mid-turn and only folds once the next page completes it; the reader must stay
// with that turn instead of landing at history start and draining every older page.
test("keeps the reader on the turn that folds when an older item page completes it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const published = await startPublishedDaemonAgent({
    publishedVersion: "0.13.0-beta.2",
    serverIdPrefix: "srv_old_fold_",
    repoPrefix: "timeline-old-daemon-fold-",
    title: "Published daemon folded turn pagination",
  });
  const { agent, serverId } = published;
  const prompts = Array.from({ length: 5 }, (_, index) => `Realistic turn ${index}: inspect it`);

  try {
    for (const prompt of prompts) {
      await agent.client.sendAgentMessage(agent.agentId, prompt);
      await agent.client.waitForFinish(agent.agentId, 30_000);
    }
    await published.seedBrowser(page, { chatDisplay: "collapseTurns" });
    const history = await holdOlderHistoryPages(page, agent, {
      daemonPort: published.daemon.port,
    });
    await openAgentTimeline(page, agent, serverId);
    await expectTimelinePromptVisible(page, prompts.at(-1)!);

    await userScrollsTimelineToHistoryStart(page);
    await history.expectRequestedPages(1);
    const partialTurnPrompt = await expectOldestLoadedTurnPartial(page, prompts);

    history.releasePage(1);
    await expectFoldedTurnAtReadingPosition(page, partialTurnPrompt);
    await history.expectSettledWithRequestedPages(1);
  } finally {
    await published.close();
  }
});
