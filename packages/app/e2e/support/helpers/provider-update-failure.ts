import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test as base, type Page } from "../fixtures";
import { gotoAppShell, openSettings } from "./app";
import { connectDaemonClient } from "./daemon-client-loader";
import { copyPluginExample, pluginRequirements } from "./plugin-fixture";
import { getServerId } from "./server-id";
import { leaveProviderDetail, openSettingsHostSection } from "./settings";

const PLUGIN_ID = "provider-update-failure";
const PROVIDER_ID = "update-failure";
const PROVIDER_NAME = "Update failure";
const FAILURE = "The updater could not write to the install directory";

/** The direct provider example with an installation whose updater always fails. */
const SERVER_SOURCE = `import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDirectExampleProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider({
    ...createDirectExampleProvider(),
    id: ${JSON.stringify(PROVIDER_ID)},
    label: ${JSON.stringify(PROVIDER_NAME)},
    installation: {
      async inspect() {
        return { status: "installed", version: "1.0.0" };
      },
      async update({ report }) {
        report({ type: "stderr", text: "EACCES\\n" });
        return { status: "failed", message: ${JSON.stringify(FAILURE)} };
      },
    },
  });
  return () => {};
}
`;

type ObserverClient = Pick<
  InternalDaemonClient,
  | "close"
  | "connect"
  | "getDaemonConfig"
  | "inspectProviderInstallation"
  | "installDirectoryPlugin"
  | "patchDaemonConfig"
  | "removePlugin"
>;

interface ProviderUpdateFailure {
  page: Page;
  /** A second client of the same host. */
  otherClient: ObserverClient;
}

export const test = base.extend<{ providerUpdateFailure: ProviderUpdateFailure }>({
  providerUpdateFailure: async ({ page }, provide) => {
    const client = await connectDaemonClient<ObserverClient>({
      clientIdPrefix: "app-e2e-provider-update-failure",
    });
    const plugin = await copyPluginExample("provider-direct");
    try {
      const previous = await client.getDaemonConfig();
      await writeFile(
        path.join(plugin.directory, "paseo-plugin.json"),
        JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
      );
      await writeFile(path.join(plugin.directory, "index.server.ts"), SERVER_SOURCE);
      try {
        await client.patchDaemonConfig({ pluginsEnabled: true });
        await client.installDirectoryPlugin(plugin.directory);
        await provide({ page, otherClient: client });
      } finally {
        try {
          await client.removePlugin(PLUGIN_ID);
        } finally {
          await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        }
      }
    } finally {
      await plugin.cleanup();
      await client.close();
    }
  },
});

export async function openProviderInstallation(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "providers");
  await page
    .getByRole("button", { name: `${PROVIDER_NAME} provider details`, exact: true })
    .click();
  await expect(page.getByTestId("provider-installation-version")).toHaveText("1.0.0");
}

export async function runFailingUpdate(page: Page): Promise<void> {
  await page.getByTestId("provider-update-start").click();
  await expect(page.getByTestId("provider-update-status")).toHaveText("Update failed");
  await expect(page.getByTestId("provider-update-message")).toHaveText(FAILURE);
}

export async function refreshProviderDetails(page: Page): Promise<void> {
  await page.getByTestId("provider-refresh").click();
}

export async function backToProviderList(page: Page): Promise<void> {
  await leaveProviderDetail(page);
}

function providerRow(page: Page) {
  return page.getByTestId(`provider-row-${PROVIDER_ID}`);
}

/** The provider's row in the list reports the failed update, with the error dot. */
export async function expectRowReportsUpdateFailure(page: Page): Promise<void> {
  const row = providerRow(page);
  await expect(row).toContainText(FAILURE);
  await expect(row.getByTestId("settings-row-error-dot")).toHaveCount(1);
}

/** The provider's row reads its version and model count again, with no error dot. */
export async function expectRowReadsVersionAndModels(page: Page): Promise<void> {
  const row = providerRow(page);
  await expect(row).toContainText("1.0.0 · 1 model");
  await expect(row).not.toContainText(FAILURE);
  await expect(row.getByTestId("settings-row-error-dot")).toHaveCount(0);
}

export async function refreshFromOtherClient(client: ObserverClient): Promise<void> {
  const result = await client.inspectProviderInstallation(PROVIDER_ID, { refresh: true });
  expect(result.error).toBeNull();
}

export async function expectNoUpdateFailure(page: Page): Promise<void> {
  await expect(page.getByTestId("provider-update-run")).toHaveCount(0);
  await expect(page.getByTestId("provider-installation-version")).toHaveText("1.0.0");
}
