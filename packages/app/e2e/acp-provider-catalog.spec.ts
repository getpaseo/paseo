import { test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { getServerId } from "./helpers/server-id";
import {
  expectProviderInstalledInSettings,
  installAcpCatalogProvider,
  openAddProviderModal,
  openSettingsHost,
  openSettingsHostSection,
} from "./helpers/settings";

const ACP_PROVIDER = {
  id: "hermes",
  name: "Hermes",
};

test.describe("ACP provider catalog", () => {
  test("adds a catalog provider from settings", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, getServerId());
    // Providers moved to their own host section; add-provider lives there now.
    await openSettingsHostSection(page, getServerId(), "providers");
    await openAddProviderModal(page);

    await installAcpCatalogProvider(page, ACP_PROVIDER.name);
    await expectProviderInstalledInSettings(page, ACP_PROVIDER.name);
  });
});
