import { test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  openSettingsHost,
  openSettingsHostSection,
} from "../support/helpers/settings";

// Covers the full manifest -> daemon -> app pipeline for the new built-in
// jcode provider: the settings providers section lists Jcode (rendered with
// its provider icon) without any custom provider config.
test("lists the built-in Jcode provider in host settings", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await openSettingsHostSection(page, getServerId(), "providers");

  await expectProviderInstalledInSettings(page, "Jcode");
});
