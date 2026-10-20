import { test } from "../support/fixtures";
import {
  expectConnectedHostControlsFit,
  closeConnectedHostDetails,
  toggleConnectedHost,
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

import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";

test.describe("compact connected host controls", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("long host names keep both actions visible with details open and closed", async ({
    page,
  }, testInfo) => {
    const destination = await startIsolatedHostDaemon("srv_connected_layout");
    const label = "Production build host — development-infrastructure-europe-west";
    try {
      await openCompactConnectedHosts(page);
      await addConnectedHost(page, `127.0.0.1:${destination.port}`, label);
      await expectConnectedHostControlsFit(page, label, true);
      await inspectConnectedHost(page, label);
      await expectConnectedHostControlsFit(page, label, true);
      await closeConnectedHostDetails(page);
      await toggleConnectedHost(page, true);
      await expectConnectedHostControlsFit(page, label, false);
      await inspectConnectedHost(page, label);
      await expectConnectedHostControlsFit(page, label, false);
      await page.screenshot({ path: testInfo.outputPath("connected-host-controls.png") });
      await closeConnectedHostDetails(page);
      await toggleConnectedHost(page, false);
      await expectConnectedHostControlsFit(page, label, true);
    } finally {
      await destination.close();
    }
  });
});
