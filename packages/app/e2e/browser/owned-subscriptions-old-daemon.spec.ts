import { randomUUID } from "node:crypto";
import {
  focusTerminalSurface,
  typeInTerminal,
  getTerminalBufferText,
} from "../support/helpers/terminal-perf";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { metroTest as test, expect } from "../support/fixtures";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import type { MockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentTimeline } from "../support/helpers/timeline-pagination";

test("requires a host update for whole-turn history while retaining old-daemon connections and terminals", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const serverId = `srv_old_pagination_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const daemon = await startIsolatedHostDaemon(serverId, { publishedVersion: "0.2.5" });
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
  const workspace = await seedWorkspace({
    repoPrefix: "timeline-old-daemon-pagination-",
    port: daemon.port,
  });
  const createdAgent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Published daemon pagination regression",
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

  try {
    await agent.client.sendAgentMessage(agent.agentId, "emit 1 coalesced agent stream updates");
    await agent.client.waitForFinish(agent.agentId, 15_000);

    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${daemon.port}`,
      nowIso: new Date().toISOString(),
    });
    await page.addInitScript(
      ({ seededHost, preferences }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
        localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
      },
      { seededHost: host, preferences: buildCreateAgentPreferences() },
    );

    await openAgentTimeline(page, agent, serverId);
    const updateMessage = page.getByText("Update the host to load complete conversation turns.", {
      exact: true,
    });
    await expect(updateMessage).toBeVisible();
    expect(observationSockets.size).toBe(1);

    await test.step("retain one directory observation after reconnecting the old daemon", async () => {
      await daemon.restart();
      await expect.poll(() => observationSockets.size, { timeout: 30_000 }).toBe(2);
      await expect(updateMessage).toBeVisible();
      await agent.client.connect();
    });

    await test.step("open a terminal and receive its output", async () => {
      const terminal = await agent.client.createTerminal(agent.cwd, "Compatibility terminal");
      expect(terminal.error).toBeNull();
      const terminalId = terminal.terminal!.id;
      const route = buildHostWorkspaceRoute(serverId, workspace.workspaceId);
      await page.goto(`${route}?open=${encodeURIComponent(`terminal:${terminalId}`)}`);
      await focusTerminalSurface(page);
      await typeInTerminal(page, "printf 'compatibility-%s\\n' terminal-output\n");
      await expect
        .poll(() => getTerminalBufferText(page), { timeout: 15_000 })
        .toContain("compatibility-terminal-output");
      await agent.client.killTerminal(terminalId);
    });
  } finally {
    await agent.cleanup();
    await daemon.close();
  }
});
