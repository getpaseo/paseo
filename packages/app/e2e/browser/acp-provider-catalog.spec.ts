import {
  closeModelPicker,
  openModelPicker,
  seedAgentProfiles,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { writeFile } from "node:fs/promises";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  findAcpCatalogProvider,
  installAcpCatalogProvider,
  openAddProviderArea,
  openSettingsHost,
  openSettingsHostSection,
  seedSavedSettingsHosts,
} from "../support/helpers/settings";

const ACP_PROVIDER = {
  id: "minimax-code",
  name: "MiniMax Code",
};

interface ProviderCatalogDaemonClient {
  getLastServerInfoMessage(): {
    features?: { hopliteProvider?: boolean; plugins?: boolean };
  } | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  getDaemonConfig(): Promise<{ config: { providers?: Record<string, unknown> } }>;
  getProvidersSnapshot(): Promise<{ entries: Array<{ provider: string }> }>;
  patchDaemonConfig(config: { removeProviders?: string[] }): Promise<unknown>;
}

test.describe("ACP provider catalog", () => {
  test("adds MiniMax Code from settings", async ({ page }) => {
    const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
      clientIdPrefix: "provider-catalog-e2e",
    });
    try {
      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");
      await openAddProviderArea(page);

      await installAcpCatalogProvider(page, ACP_PROVIDER.name);
      await expectProviderInstalledInSettings(page, ACP_PROVIDER.name);
    } finally {
      await client.patchDaemonConfig({ removeProviders: [ACP_PROVIDER.id] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`adds Hoplite from the catalog in ${theme} theme`, async ({ page }, testInfo) => {
    const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
      clientIdPrefix: "hoplite-catalog-e2e",
    });
    try {
      expect(client.getLastServerInfoMessage()?.features?.hopliteProvider).toBe(true);
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
      expect(
        (await client.getProvidersSnapshot()).entries.some((entry) => entry.provider === "hoplite"),
      ).toBe(false);
      await page.addInitScript((value) => {
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: value }));
      }, theme);
      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");
      await expect(
        page.getByRole("button", { name: "Hoplite provider details", exact: true }),
      ).toHaveCount(0);
      await openAddProviderArea(page);
      await findAcpCatalogProvider(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-catalog-${theme}.png`) });
      await installAcpCatalogProvider(page, "Hoplite");
      await expectProviderInstalledInSettings(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-installed-${theme}.png`) });
      expect((await client.getDaemonConfig()).config.providers?.hoplite).toEqual({ enabled: true });
      await writeFile(
        testInfo.outputPath(`hoplite-added-${theme}.json`),
        JSON.stringify(await client.getProvidersSnapshot(), null, 2),
      );
      await removeHoplite(page);
      await expect(
        page.getByRole("button", { name: "Hoplite provider details", exact: true }),
      ).toHaveCount(0);
      expect((await client.getDaemonConfig()).config.providers?.hoplite).toBeUndefined();
      expect(
        (await client.getProvidersSnapshot()).entries.some((entry) => entry.provider === "hoplite"),
      ).toBe(false);
      await writeFile(
        testInfo.outputPath(`hoplite-removed-${theme}.json`),
        JSON.stringify(await client.getProvidersSnapshot(), null, 2),
      );
      await openAddProviderArea(page);
      await findAcpCatalogProvider(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-removed-${theme}.png`) });
      await installAcpCatalogProvider(page, "Hoplite");
      await expectProviderInstalledInSettings(page, "Hoplite");
    } finally {
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
}

async function removeHoplite(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("provider-actions-hoplite").click();
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByTestId("provider-remove-hoplite").click();
}

test("unsupported host asks for an update without writing Hoplite config", async ({
  page,
  outdatedDaemon,
}, testInfo) => {
  const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
    clientIdPrefix: "hoplite-unsupported",
    port: Number(new URL(`http://${outdatedDaemon.endpoint}`).port),
  });
  try {
    expect(client.getLastServerInfoMessage()?.features?.plugins).toBe(true);
    expect(client.getLastServerInfoMessage()?.features?.hopliteProvider).toBe(false);
    const before = await client.getDaemonConfig();
    await seedSavedSettingsHosts(page, [outdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, outdatedDaemon.serverId);
    await openSettingsHostSection(page, outdatedDaemon.serverId, "providers");
    await openAddProviderArea(page);
    await page.getByRole("button", { name: "Add Hoplite", exact: true }).click();
    const errorToast = page.getByTestId("app-toast-message");
    await expect(errorToast).toHaveText("Update the host to add Hoplite.");
    await expect(errorToast).toBeInViewport();
    expect((await client.getDaemonConfig()).config).toEqual(before.config);
    await expect(
      page.getByRole("button", { name: "Hoplite provider details", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("hoplite-update-host.png") });
  } finally {
    await client.close();
  }
});

test("model selector excludes Hoplite before opt-in", async ({ page }, testInfo) => {
  const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
    clientIdPrefix: "hoplite-picker",
  });
  const profiles = await seedAgentProfiles([
    { id: "hoplite-picker-anchor", name: "Picker anchor", provider: "mock" },
  ]);
  const workspace = await seedWorkspace({ repoPrefix: "hoplite-picker-" });
  try {
    await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await expectComposerVisible(page);
    await openModelPicker(page);
    await expect(page.getByTestId("model-provider-mock")).toBeVisible();
    await expect(page.getByTestId("model-provider-hoplite")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("hoplite-model-selector-absent.png") });
    await closeModelPicker(page);
  } finally {
    await workspace.cleanup();
    await profiles.restore();
    await client.close();
  }
});
