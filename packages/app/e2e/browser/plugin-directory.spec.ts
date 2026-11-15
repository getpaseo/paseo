import {
  test,
  expectStillBrowsing,
  installListingFromRow,
  openDirectory,
  openListingPage,
  uninstallFromListingPage,
} from "../support/helpers/plugin-directory";

test("installs a listed plugin from Browse and uninstalls it from its page", async ({
  page,
  directoryHost,
}) => {
  await openDirectory(page, directoryHost);
  await installListingFromRow(page);
  await expectStillBrowsing(page);
  await openListingPage(page);
  await uninstallFromListingPage(page);
});
