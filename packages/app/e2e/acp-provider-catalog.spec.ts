import { test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import {
  expectProviderInstalledInSettings,
  installAcpCatalogProvider,
  openAddProviderModal,
  openSettingsHost,
} from "./helpers/settings";

const ACP_PROVIDER = {
  id: "hermes",
  name: "Hermes",
};

function getSeededServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

test.describe("ACP provider catalog", () => {
  test("adds a catalog provider from settings", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, getSeededServerId());
    await openAddProviderModal(page);

    await installAcpCatalogProvider(page, ACP_PROVIDER.name);
    await expectProviderInstalledInSettings(page, ACP_PROVIDER.name);
  });
});
