import { expect, test, type Page } from "../support/fixtures";
import path from "node:path";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import {
  applyProfileFromPicker,
  drillIntoProvider,
  openModelPicker,
  seedAgentProfiles,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";
const MODELESS_PROVIDER = "modeless-profile-e2e";
const MODELESS_MODEL = "pi-profile-model";

type WebSocketMessage = string | Buffer;

interface CreateAgentRequestMessage {
  type: "create_agent_request";
  config?: {
    provider?: unknown;
    modeId?: unknown;
    featureValues?: unknown;
  };
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(rawMessage) as { type?: unknown; message?: unknown };
    return envelope.type === "session" && envelope.message && typeof envelope.message === "object"
      ? (envelope.message as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function recordAndBlockCreateAgentRequest(page: Page): Promise<{
  waitForRequest(): Promise<CreateAgentRequestMessage>;
}> {
  let resolveRequest: ((message: CreateAgentRequestMessage) => void) | null = null;
  const request = new Promise<CreateAgentRequestMessage>((resolve) => {
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
    server.onMessage((message) => ws.send(message));
  });

  return { waitForRequest: () => request };
}

async function seedPoisonedModelessPreference(page: Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, provider, model }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          provider,
          providerPreferences: {
            [provider]: { model, mode: "full-access" },
            mock: { model: "ten-second-stream", mode: "load-test" },
          },
        } satisfies FormPreferences),
      );
    },
    {
      preferencesKey: CREATE_AGENT_PREFERENCES_KEY,
      provider: MODELESS_PROVIDER,
      model: MODELESS_MODEL,
    },
  );
}

async function readProviderModePreference(page: Page, provider: string): Promise<unknown> {
  return page.evaluate(
    ({ preferencesKey, providerId }) => {
      const raw = localStorage.getItem(preferencesKey);
      if (!raw) return null;
      const preferences = JSON.parse(raw) as FormPreferences;
      return preferences.providerPreferences?.[providerId]?.mode ?? null;
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY, providerId: provider },
  );
}

test.describe("Agent profiles repair modeless provider preferences", () => {
  test.describe.configure({ timeout: 240_000 });

  test("applying a profile heals a stale mode before returning to Pi", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "profile-modeless-preferences-" });
    const profiles = await seedAgentProfiles([
      {
        id: "agent_profile_modeless_repair",
        name: "Approval work",
        provider: "mock",
        model: "one-minute-stream",
        modeId: "approval-test",
      },
    ]);
    const provider = await seedModelProvider({
      id: MODELESS_PROVIDER,
      label: "Pi profile test",
      extends: "pi",
      command: [process.execPath, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
      models: [
        {
          id: MODELESS_MODEL,
          label: "Pi profile model",
          description: "Modeless profile regression model",
        },
      ],
    });
    await seedPoisonedModelessPreference(page);
    const createAgentRecorder = await recordAndBlockCreateAgentRequest(page);

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

      await openModelPicker(page);
      await applyProfileFromPicker(page, "Approval work");

      await expect
        .poll(() => readProviderModePreference(page, MODELESS_PROVIDER), { timeout: 10_000 })
        .toBeNull();
      await expect
        .poll(() => readProviderModePreference(page, "mock"), { timeout: 10_000 })
        .toBe("approval-test");

      await openModelPicker(page);
      await drillIntoProvider(page, MODELESS_PROVIDER);
      await page.getByRole("button", { name: /Pi profile model/ }).click();

      await submitNewWorkspacePrompt(page, "Create a Pi agent after repairing preferences.");
      const createAgentRequest = await createAgentRecorder.waitForRequest();
      expect(createAgentRequest).toMatchObject({
        config: { provider: MODELESS_PROVIDER },
      });
      expect(createAgentRequest.config).not.toHaveProperty("modeId");
    } finally {
      await workspace.cleanup();
      await provider.restore();
      await profiles.restore();
    }
  });

  test("cross-provider profile features survive immediate workspace creation", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "profile-feature-transition-" });
    const featureProviderId = "profile-feature-e2e";
    const featureModelId = "claude-opus-5";
    const profiles = await seedAgentProfiles([
      {
        id: "agent_profile_feature_transition",
        name: "Fast profile",
        provider: featureProviderId,
        model: featureModelId,
        modeId: "bypassPermissions",
        featureValues: { fast_mode: true },
      },
    ]);
    const provider = await seedModelProvider({
      id: featureProviderId,
      label: "Profile feature test",
      models: [
        {
          id: featureModelId,
          label: "Profile feature model",
          description: "Cross-provider feature regression model",
        },
      ],
    });
    const createAgentRecorder = await recordAndBlockCreateAgentRequest(page);

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

      await openModelPicker(page);
      await applyProfileFromPicker(page, "Fast profile");
      await submitNewWorkspacePrompt(page, "Create an agent with profile features.");

      const createAgentRequest = await createAgentRecorder.waitForRequest();
      expect(createAgentRequest).toMatchObject({
        config: {
          provider: featureProviderId,
          featureValues: { fast_mode: true },
        },
      });
    } finally {
      await workspace.cleanup();
      await provider.restore();
      await profiles.restore();
    }
  });
});
