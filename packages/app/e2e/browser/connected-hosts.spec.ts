import { test } from "../support/fixtures";
import {
  openRestartableConnectedHosts,
  beginConnectedHostDraft,
  reconnectManagingHost,
  expectConnectedHostDraftRetained,
  saveConnectedHost,
  openConnectedHosts,
  openCompactConnectedHosts,
  addConnectedHost,
  expectConnectionError,
  correctConnection,
  inspectConnectedHost,
  expectSavedHostDetails,
  disableConnectedHost,
  enableConnectedHost,
  editConnectedHost,
  removeConnectedHost,
} from "../support/helpers/connected-hosts";

test("invalid input stays editable; unreachable hosts remain manageable", async ({
  page,
}, testInfo) => {
  await openConnectedHosts(page);
  await addConnectedHost(page, "ssh://-invalid", "Build box");
  await expectConnectionError(page);
  await correctConnection(page, "tcp://127.0.0.1:1?password=private-secret");
  await inspectConnectedHost(page, "Build box");
  await expectSavedHostDetails(page);
  await page.screenshot({ path: testInfo.outputPath("connected-host-details.png") });
  await editConnectedHost(page);
  await disableConnectedHost(page);
  await enableConnectedHost(page);
  await removeConnectedHost(page, "Renamed box");
});

test.describe("compact connected hosts", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("saved hosts can be inspected and disabled on a phone layout", async ({
    page,
  }, testInfo) => {
    await openCompactConnectedHosts(page);
    await addConnectedHost(page, "tcp://127.0.0.1:1", "Compact host");
    await inspectConnectedHost(page, "Compact host");
    await expectSavedHostDetails(page);
    await page.screenshot({
      path: testInfo.outputPath("connected-host-compact.png"),
      fullPage: true,
    });
    await disableConnectedHost(page);
    await removeConnectedHost(page, "Compact host");
  });
});

test("connection loss retains the unsaved name and credential input", async ({ page }) => {
  const host = await openRestartableConnectedHosts(page);
  try {
    await beginConnectedHostDraft(page);
    await reconnectManagingHost(host);
    await expectConnectedHostDraftRetained(page);
    await saveConnectedHost(page);
    await inspectConnectedHost(page, "Retained draft");
  } finally {
    await host.close();
  }
});
