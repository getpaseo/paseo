import { test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  installAcpCatalogProvider,
  openAddProviderArea,
  openSettingsHost,
  openSettingsHostSection,
} from "../support/helpers/settings";

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
    await openAddProviderArea(page);

    await installAcpCatalogProvider(page, ACP_PROVIDER.name);
    await expectProviderInstalledInSettings(page, ACP_PROVIDER.name);
  });
});
