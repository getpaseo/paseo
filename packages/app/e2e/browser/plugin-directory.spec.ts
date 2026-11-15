import {
  test,
  expectStillBrowsing,
  installFromPage,
  installListingFromRow,
  openDirectory,
  openFromInstalledTab,
  openListingPage,
  uninstallFromPage,
} from "../support/helpers/plugin-directory";

test("installs a listed plugin from Browse and uninstalls it from either of its pages", async ({
  page,
  directoryHost,
}) => {
  await openDirectory(page, directoryHost);
  await installListingFromRow(page);
  await expectStillBrowsing(page);
  await openListingPage(page);
  await uninstallFromPage(page);
  await installFromPage(page);
  await openFromInstalledTab(page);
  await uninstallFromPage(page);
});
