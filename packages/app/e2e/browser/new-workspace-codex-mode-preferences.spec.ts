import { expect, type Page } from "../support/fixtures";
import { test } from "../support/creation-fixtures";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { gotoAppShell } from "../support/helpers/app";
import { captureWorkspaceAgentRequest } from "../support/helpers/creation";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { expectNoTruncation } from "../support/helpers/no-truncation";
import { escapeRegex } from "../support/helpers/regex";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

async function seedCodexDefaultPermissionPreferences(page: Page, cwd: string): Promise<string> {
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "codex-mode-preferences",
  });
  try {
    await expect
      .poll(
        async () =>
          (await client.getProvidersSnapshot({ cwd })).entries.find(
            (entry) => entry.provider === "codex",
          )?.status,
      )
      .toBe("ready");
    const snapshot = await client.getProvidersSnapshot({ cwd });
    const model = snapshot.entries
      .find((entry) => entry.provider === "codex")
      ?.models?.find((candidate) => candidate.thinkingOptions?.length);
    if (!model?.thinkingOptions?.[0])
      throw new Error("Codex catalogue must expose a model with thinking options");
    await page.addInitScript(
      ({ preferencesKey, modelId, thinkingOptionId }) => {
        localStorage.setItem(
          preferencesKey,
          JSON.stringify({
            provider: "codex",
            providerPreferences: {
              codex: {
                model: modelId,
                mode: "auto",
                thinkingByModel: { [modelId]: thinkingOptionId },
              },
              mock: { model: "ten-second-stream" },
            },
          } satisfies FormPreferences),
        );
      },
      {
        preferencesKey: CREATE_AGENT_PREFERENCES_KEY,
        modelId: model.id,
        thinkingOptionId: model.thinkingOptions[0].id,
      },
    );
    return model.id;
  } finally {
    await client.close();
  }
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
  const modeControl = page.getByRole("button", { name: /^Select agent mode \(/ });
  await expect(modeControl).toBeVisible({ timeout: 30_000 });
  await modeControl.click();

  const popup = page.getByTestId("combobox-desktop-container").last();
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expectNoTruncation(popup);

  const searchInput = page.getByRole("textbox", { name: /search mode/i });
  await expect(searchInput).toBeVisible({ timeout: 10_000 });
  await searchInput.fill(label);

  const option = popup.getByText(new RegExp(`^${escapeRegex(label)}$`, "i")).first();
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

test.describe("New workspace Codex mode preferences", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps Full Access as the global Codex mode after the workspace draft auto-submit handoff", async ({
    page,
    startup,
  }) => {
    const seeded = await seedWorkspace({ repoPrefix: "codex-mode-preferences-" });
    const createAgentRecorder = await captureWorkspaceAgentRequest(page, { block: false });
    try {
      await seedCodexDefaultPermissionPreferences(page, seeded.repoPath);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      });

      await expect(
        page.getByRole("button", { name: "Select agent mode (Default permissions)" }),
      ).toBeVisible({ timeout: 30_000 });
      await expectThinkingOptionsFit(page);
      await selectMode(page, "Full access");
      await expect(
        page.getByRole("button", { name: "Select agent mode (Full access)" }),
      ).toBeVisible();

      await submitNewWorkspacePrompt(page, "Keep Codex full access selected globally.");
      const createAgentRequest = await createAgentRecorder.waitForRequest();

      await expect(page).toHaveURL(/\/workspace\//);
      await expect(
        page.getByText("Keep Codex full access selected globally.", { exact: true }).first(),
      ).toBeVisible();
      expect(createAgentRequest.config).toMatchObject({
        provider: "codex",
        modeId: "full-access",
      });
      await expect
        .poll(() => readCodexModePreference(page), { timeout: 10_000 })
        .toBe("full-access");
      await startup.fail();
      await expect(page.getByText(/Creation startup failed for test/).first()).toBeVisible();
    } finally {
      await seeded.cleanup();
    }
  });

  test("uses the live Codex agent mode as the next New Workspace default", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "codex-live-mode-preferences-" });
    try {
      const model = await seedCodexDefaultPermissionPreferences(page, seeded.repoPath);
      const agent = await seeded.client.createAgent({
        provider: "codex",
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: "Codex live mode preference e2e",
        modeId: "auto",
        model,
      });

      await openAgentRoute(page, {
        workspaceId: seeded.workspaceId,
        agentId: agent.id,
      });
      await expect(
        page.getByRole("button", { name: "Select agent mode (Default permissions)" }),
      ).toBeVisible({ timeout: 30_000 });

      await selectMode(page, "Full access");
      await expect(
        page.getByRole("button", { name: "Select agent mode (Full access)" }),
      ).toBeVisible({ timeout: 30_000 });

      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      });

      await expect(
        page.getByRole("button", { name: "Select agent mode (Full access)" }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await seeded.cleanup();
    }
  });
});
