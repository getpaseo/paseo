import { expect, test, type Page } from "./fixtures";
import { daemonWsRoutePattern } from "./helpers/daemon-port";
import { openAgentRoute } from "./helpers/mock-agent";
import { openGlobalNewWorkspaceComposer, selectNewWorkspaceProject } from "./helpers/new-workspace";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

type WebSocketMessage = string | Buffer;

function parseWebSocketJson(message: WebSocketMessage): unknown {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseWebSocketJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

// The draft mode control in New Workspace only mutates local form state; it never sends
// set_agent_mode_request. So the only source of such a request while the New Workspace
// composer is focused is a *live* agent's mode control. Recording those, keyed by agentId,
// gives a direct signal that Shift+Tab leaked into a backgrounded agent.
async function recordSetAgentModeRequests(page: Page): Promise<{
  requestsForAgent(agentId: string): Array<{ agentId: string; modeId: string }>;
}> {
  const seen: Array<{ agentId: string; modeId: string }> = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "set_agent_mode_request") {
        const agentId = typeof sessionMessage.agentId === "string" ? sessionMessage.agentId : "";
        const modeId = typeof sessionMessage.modeId === "string" ? sessionMessage.modeId : "";
        seen.push({ agentId, modeId });
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return {
    requestsForAgent: (agentId: string) => seen.filter((request) => request.agentId === agentId),
  };
}

async function seedCodexDefaultPreferences(page: Page, serverId: string): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, serverId: seededServerId }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          serverId: seededServerId,
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.4-mini",
              mode: "auto",
              thinkingByModel: { "gpt-5.4-mini": "low" },
            },
            mock: { model: "ten-second-stream" },
          },
        }),
      );
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY, serverId },
  );
}

// Focus the New Workspace composer and cycle the execution mode with the keyboard.
// Kept out of the test body so the test reads as intent rather than key mechanics.
async function cycleNewWorkspaceMode(page: Page, presses: number): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Shift+Tab");
  }
}

test.describe("New Workspace mode cycle safety", () => {
  test.describe.configure({ timeout: 240_000 });

  // Regression guard for the P1 safety bug: cycling the execution mode with Shift+Tab in
  // the New Workspace composer must never reach a backgrounded, still-mounted agent's mode
  // control and silently change that (possibly running) agent's mode — e.g. into a
  // permissive/bypass mode. See use-keyboard-action-handler.ts.
  test("Shift+Tab in New Workspace never changes a backgrounded agent's mode", async ({ page }) => {
    const serverId = getServerId();
    const seeded = await seedWorkspace({ repoPrefix: "mode-cycle-safety-" });
    await seedCodexDefaultPreferences(page, serverId);
    const modeRequests = await recordSetAgentModeRequests(page);

    try {
      const agent = await seeded.client.createAgent({
        provider: "codex",
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: "mode cycle safety e2e",
        modeId: "auto",
        model: "gpt-5.4-mini",
      });

      // Mount the live agent tab: its mode control registers a mode-cycle keyboard handler.
      await openAgentRoute(page, { workspaceId: seeded.workspaceId, agentId: agent.id });
      await expect(page.getByTestId("mode-control").first()).toContainText("Default permissions", {
        timeout: 30_000,
      });

      // Move to the New Workspace composer. The agent tab stays mounted in the background,
      // so its handler is still registered when we cycle here.
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectId,
        projectDisplayName: seeded.projectDisplayName,
      });

      await cycleNewWorkspaceMode(page, 6);

      // fetchAgents is a real daemon round-trip; once it resolves, any mode change the
      // presses would have triggered has already landed. Assert the running agent is
      // untouched — both its committed mode and on the wire — with no fixed sleep.
      const agents = await seeded.client.fetchAgents();
      const backgroundAgent = agents.entries.find((entry) => entry.agent.id === agent.id)?.agent;
      expect(backgroundAgent?.currentModeId).toBe("auto");
      expect(modeRequests.requestsForAgent(agent.id)).toEqual([]);
    } finally {
      await seeded.cleanup();
    }
  });
});
