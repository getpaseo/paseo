import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { daemonWsRoutePattern } from "./helpers/daemon-port";
import { openAgentRoute } from "./helpers/mock-agent";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspacePrompt,
} from "./helpers/new-workspace";
import { expectNoTruncation } from "./helpers/no-truncation";
import { escapeRegex } from "./helpers/regex";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

type WebSocketMessage = string | Buffer;

interface CreateAgentRequestMessage {
  type: "create_agent_request";
  config?: {
    provider?: unknown;
    modeId?: unknown;
  };
}

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

async function seedCodexDefaultPermissionPreferences(page: Page, serverId: string): Promise<void> {
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
              thinkingByModel: {
                "gpt-5.4-mini": "low",
              },
            },
            mock: {
              model: "ten-second-stream",
            },
          },
        }),
      );
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY, serverId },
  );
}

async function readCodexModePreference(page: Page): Promise<unknown> {
  return page.evaluate((preferencesKey) => {
    const raw = localStorage.getItem(preferencesKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      providerPreferences?: Record<string, { mode?: unknown }>;
    };
    return parsed.providerPreferences?.codex?.mode ?? null;
  }, CREATE_AGENT_PREFERENCES_KEY);
}

async function selectMode(page: Page, label: string): Promise<void> {
  const modeControl = page.getByTestId("mode-control").first();
  await expect(modeControl).toBeVisible({ timeout: 30_000 });
  await modeControl.click();

  const popup = page.getByTestId("combobox-desktop-container").last();
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expectNoTruncation(popup);

  const searchInput = page.getByRole("textbox", { name: /search mode/i });
  await expect(searchInput).toBeVisible({ timeout: 10_000 });
  await searchInput.fill(label);

  const option = page
    .getByRole("dialog")
    .last()
    .getByText(new RegExp(`^${escapeRegex(label)}$`, "i"))
    .first();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click({ force: true });
  await expect(searchInput).not.toBeVisible({ timeout: 5_000 });
}

async function expectThinkingOptionsFit(page: Page): Promise<void> {
  const thinkingControl = page.getByTestId("agent-thinking-selector").first();
  await expect(thinkingControl).toBeVisible({ timeout: 30_000 });
  await thinkingControl.click();

  const popup = page.getByTestId("combobox-desktop-container").last();
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expectNoTruncation(popup);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("combobox-desktop-container")).toHaveCount(0, { timeout: 5_000 });
}

async function recordAndBlockCreateAgentRequests(page: Page): Promise<{
  waitForCreateAgentRequest(): Promise<CreateAgentRequestMessage>;
}> {
  let resolveRequest: ((message: CreateAgentRequestMessage) => void) | null = null;
  const createAgentSeen = new Promise<CreateAgentRequestMessage>((resolve) => {
    resolveRequest = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "create_agent_request") {
        resolveRequest?.(sessionMessage as unknown as CreateAgentRequestMessage);
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => {
      ws.send(message);
    });
  });

  return {
    waitForCreateAgentRequest: () => createAgentSeen,
  };
}

test.describe("New workspace Codex mode preferences", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps Full Access as the global Codex mode after the workspace draft auto-submit handoff", async ({
    page,
  }) => {
    const serverId = getServerId();
    const seeded = await seedWorkspace({ repoPrefix: "codex-mode-preferences-" });
    const createAgentRecorder = await recordAndBlockCreateAgentRequests(page);
    await seedCodexDefaultPermissionPreferences(page, serverId);

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectId,
        projectDisplayName: seeded.projectDisplayName,
      });

      await expect(page.getByTestId("mode-control").first()).toContainText("Default permissions", {
        timeout: 30_000,
      });
      await expectThinkingOptionsFit(page);
      await selectMode(page, "Full access");
      await expect(page.getByTestId("mode-control").first()).toContainText("Full access");

      await submitNewWorkspacePrompt(page, "Keep Codex full access selected globally.");
      const createAgentRequest = await createAgentRecorder.waitForCreateAgentRequest();

      expect(createAgentRequest.config).toMatchObject({
        provider: "codex",
        modeId: "full-access",
      });
      await expect
        .poll(() => readCodexModePreference(page), { timeout: 10_000 })
        .toBe("full-access");
    } finally {
      await seeded.cleanup();
    }
  });

  test("uses the live Codex agent mode as the next New Workspace default", async ({ page }) => {
    const serverId = getServerId();
    const seeded = await seedWorkspace({ repoPrefix: "codex-live-mode-preferences-" });
    await seedCodexDefaultPermissionPreferences(page, serverId);

    try {
      const agent = await seeded.client.createAgent({
        provider: "codex",
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: "Codex live mode preference e2e",
        modeId: "auto",
        model: "gpt-5.4-mini",
      });

      await openAgentRoute(page, {
        workspaceId: seeded.workspaceId,
        agentId: agent.id,
      });
      await expect(page.getByTestId("mode-control").first()).toContainText("Default permissions", {
        timeout: 30_000,
      });

      await selectMode(page, "Full access");
      await expect(page.getByTestId("mode-control").first()).toContainText("Full access", {
        timeout: 30_000,
      });

      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectId,
        projectDisplayName: seeded.projectDisplayName,
      });

      await expect(page.getByTestId("mode-control").first()).toContainText("Full access", {
        timeout: 30_000,
      });
    } finally {
      await seeded.cleanup();
    }
  });
});
