import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  closeModelPicker,
  drillIntoProvider,
  openModelPicker,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible, expectComposerFocused } from "../support/helpers/composer";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHost, openSettingsHostSection } from "../support/helpers/settings";

// Use an existing repository linked to the signed-in user's Hoplite project.
const cwd = process.env.E2E_HOPLITE_CWD ?? path.resolve(__dirname, "../../../..");

test.use({
  viewport: { width: 1440, height: 1000 },
  e2eDaemonConfig: { version: 1, agents: { providers: { hoplite: { enabled: true } } } },
});

async function openHopliteSettings(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await openSettingsHostSection(page, getServerId(), "providers");
  await page.getByRole("button", { name: "Hoplite provider details", exact: true }).click();
}

async function expectEmptyGlobalCatalog(page: Page, client: DaemonClient): Promise<void> {
  const models = await client.listProviderModels("hoplite");
  expect(models.error).toBeNull();
  expect(models.models).toEqual([]);
  const snapshot = await client.getProvidersSnapshot();
  expect(snapshot.entries.find((entry) => entry.provider === "hoplite")).toMatchObject({
    status: "ready",
    models: [],
  });
  await expect(page.getByText("No models detected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
}

async function refreshGlobalCatalog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled({
    timeout: 120_000,
  });
}

async function openWorkspaceModels(page: Page, workspaceId: string): Promise<void> {
  await gotoWorkspace(page, workspaceId);
  await clickNewChat(page);
  await expectComposerVisible(page);
  await expectComposerFocused(page);
  await openModelPicker(page);
  await page.getByTestId("sheet-header-back").click();
  await drillIntoProvider(page, "hoplite");
}

test("real Hoplite has an empty global catalog and discovers models in its linked workspace", async ({
  page,
  e2eWorkerClient,
}, testInfo) => {
  test.setTimeout(180_000);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "hoplite-discovery" });
  const created = await e2eWorkerClient.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "Hoplite discovery QA",
  });
  expect(created.error).toBeNull();
  const workspace = created.workspace!;
  try {
    await test.step("global settings succeed with no models, including refresh", async () => {
      await openHopliteSettings(page);
      await expectEmptyGlobalCatalog(page, client);
      await refreshGlobalCatalog(page);
      await expectEmptyGlobalCatalog(page, client);
      await page.screenshot({ path: testInfo.outputPath("hoplite-global-empty.png") });
    });

    await test.step("the linked workspace discovers real models", async () => {
      const models = await client.listProviderModels("hoplite", { cwd });
      expect(models.error).toBeNull();
      expect(models.models!.length).toBeGreaterThan(0);
      await testInfo.attach("workspace-models", {
        body: JSON.stringify(models, null, 2),
        contentType: "application/json",
      });
      await openWorkspaceModels(page, workspace.id);
      await expect(page.getByText(models.models![0]!.label, { exact: true }).last()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("hoplite-workspace-models.png") });
      await closeModelPicker(page);
    });

    await test.step("workspace discovery does not populate the global catalog", async () => {
      await openHopliteSettings(page);
      await expectEmptyGlobalCatalog(page, client);
      await refreshGlobalCatalog(page);
      await expectEmptyGlobalCatalog(page, client);
      const models = await client.listProviderModels("hoplite", { cwd });
      expect(models.error).toBeNull();
      expect(models.models!.length).toBeGreaterThan(0);
    });
  } finally {
    await client.close();
    await e2eWorkerClient.removeProject(workspace.projectId);
  }
});
