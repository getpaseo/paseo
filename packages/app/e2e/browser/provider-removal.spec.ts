import type { Dialog } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  installAcpCatalogProvider,
  openAddProviderArea,
  openSettingsHost,
  openSettingsHostSection,
} from "../support/helpers/settings";
import { copyPluginExample } from "../support/helpers/plugin-fixture";

const CUSTOM_PROVIDER = {
  id: "junie",
  name: "Junie",
} as const;

const PLUGIN_PROVIDER = {
  id: "direct-example",
  name: "Direct provider example",
  pluginId: "provider-direct-example",
} as const;

interface ProviderRemovalDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getDaemonConfig(): Promise<{ config: { pluginsEnabled?: boolean } }>;
  patchDaemonConfig(config: {
    removeProviders?: string[];
    pluginsEnabled?: boolean;
  }): Promise<unknown>;
  installDirectoryPlugin(path: string): Promise<unknown>;
  removePlugin(pluginId: string): Promise<void>;
  getProvidersSnapshot(): Promise<{
    entries: Array<{ provider: string; source?: "builtin" | "custom" }>;
  }>;
}

async function removeCustomProvider(client: ProviderRemovalDaemonClient): Promise<void> {
  await client.patchDaemonConfig({ removeProviders: [CUSTOM_PROVIDER.id] });
}

async function expectProviderSource(
  client: ProviderRemovalDaemonClient,
  source: "custom" | undefined,
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await client.getProvidersSnapshot();
      return snapshot.entries.find((entry) => entry.provider === CUSTOM_PROVIDER.id)?.source;
    })
    .toBe(source);
}

async function clickRemoveProviderAndAcceptWarning(page: Page): Promise<Dialog> {
  let warning: Dialog | undefined;
  page.once("dialog", (dialog) => {
    warning = dialog;
    expect(dialog.message()).toContain(`Remove ${CUSTOM_PROVIDER.name}?`);
    expect(dialog.message()).toContain("This deletes the provider entry from config.json.");
    void dialog.accept();
  });
  await page.getByTestId(`provider-remove-${CUSTOM_PROVIDER.id}`).click();
  if (!warning) {
    throw new Error("Expected a provider removal confirmation dialog, but none was shown.");
  }
  return warning;
}

test.describe("provider removal", () => {
  test("removes a custom provider from Settings", async ({ page }) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<ProviderRemovalDaemonClient>({
      clientIdPrefix: "provider-removal-e2e",
    });

    try {
      await removeCustomProvider(client);

      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");

      await expect(page.getByTestId("provider-actions-claude")).toHaveCount(0);
      await openAddProviderArea(page);
      await installAcpCatalogProvider(page, CUSTOM_PROVIDER.name);
      await expectProviderInstalledInSettings(page, CUSTOM_PROVIDER.name);
      await expectProviderSource(client, "custom");

      await page.getByTestId(`provider-actions-${CUSTOM_PROVIDER.id}`).click();
      await expect(page.getByTestId(`provider-remove-${CUSTOM_PROVIDER.id}`)).toBeVisible();
      await clickRemoveProviderAndAcceptWarning(page);

      await expect(
        page.getByRole("button", {
          name: `${CUSTOM_PROVIDER.name} provider details`,
          exact: true,
        }),
      ).toHaveCount(0);
      await expectProviderSource(client, undefined);
    } finally {
      await removeCustomProvider(client).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });

  test("does not offer Remove for a plugin-registered provider", async ({ page }) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<ProviderRemovalDaemonClient>({
      clientIdPrefix: "provider-removal-e2e",
    });

    const plugin = await copyPluginExample("provider-direct");
    try {
      const previous = await client.getDaemonConfig();
      try {
        await client.patchDaemonConfig({ pluginsEnabled: true });
        await client.installDirectoryPlugin(plugin.directory);

        await gotoAppShell(page);
        await openSettings(page);
        await openSettingsHost(page, getServerId());
        await openSettingsHostSection(page, getServerId(), "providers");

        const pluginProviderRow = page.getByRole("button", {
          name: `${PLUGIN_PROVIDER.name} provider details`,
          exact: true,
        });
        await expect(pluginProviderRow).toBeVisible();
        await expect(page.getByTestId(`provider-actions-${PLUGIN_PROVIDER.id}`)).toHaveCount(0);

        // The provider survives a removeProviders patch pointed at it: the
        // plugin, not config.json, owns the definition.
        await client.patchDaemonConfig({ removeProviders: [PLUGIN_PROVIDER.id] });
        await expect(pluginProviderRow).toBeVisible();
      } finally {
        await client.removePlugin(PLUGIN_PROVIDER.pluginId).catch(() => undefined);
        await client
          .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled })
          .catch(() => undefined);
      }
    } finally {
      await client.close().catch(() => undefined);
      await plugin.cleanup();
    }
  });
});
