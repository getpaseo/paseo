import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  addDirectHostFromSettings,
  openSettingsHostSection,
  selectSettingsHost,
} from "../support/helpers/settings";
import { test } from "../support/fixtures";
import { startTailscaleTestDaemon } from "../support/helpers/tailscale-daemon";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  expectPairingOffer,
  cancelTailscaleTurnOff,
  confirmTailscaleTurnOff,
  connectThroughTailscale,
  disableTailscale,
  enableTailscale,
  expectTailscaleAddress,
  expectTailscaleAvailable,
  expectTailscaleRowLoadsOn,
  expectTailscaleUnavailable,
  observeDaemonStatusPolling,
  openSetupMobileStep,
  refreshTailscaleAvailability,
  slowConnectionToHost,
  expectTailscaleUpdateRequired,
  expectCompletePairingQr,
  expectRelayConsent,
  openPairDeviceModal,
  preparePairingHost,
} from "../support/helpers/pair-device";

test("opens relay consent in browser web", async ({ page }) => {
  const daemon = await startIsolatedHostDaemon("pair-device-browser-relay-off", {
    mutableRelay: { enabled: false },
  });
  try {
    await preparePairingHost(page, daemon);
    await openPairDeviceModal(page);
    await expectRelayConsent(page);
  } finally {
    await daemon.close();
  }
});

test("keeps the pairing QR code inside its compact tile", async ({ page }, testInfo) => {
  const daemon = await startIsolatedHostDaemon("pair-device-browser-compact", {
    mutableRelay: { enabled: true },
  });
  try {
    await preparePairingHost(page, daemon);
    await page.setViewportSize({ width: 320, height: 568 });
    await openPairDeviceModal(page);
    await expectPairingOffer(page);

    await expectCompletePairingQr(page);
    await page.screenshot({ path: testInfo.outputPath("pairing-compact.png") });
  } finally {
    await daemon.close();
  }
});

test("asks for a host update when Tailscale controls are unavailable", async ({ page }) => {
  const daemon = await startIsolatedHostDaemon("pair-device-browser-old-host", {
    publishedVersion: "0.13.0-beta.2",
  });
  try {
    await gotoAppShell(page);
    await openSettings(page);
    await addDirectHostFromSettings(page, { host: "127.0.0.1", port: daemon.port });
    await selectSettingsHost(page, daemon.serverId);
    await openSettingsHostSection(page, daemon.serverId, "devices");
    await expectTailscaleUpdateRequired(page);
  } finally {
    await daemon.close();
  }
});

test("turns Tailscale on and off from Devices, asking first over Tailscale", async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(process.platform !== "linux", "Uses a second IPv4 loopback address");
  // The journey opens Devices or the setup six times, two of them over a slowed connection.
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Expected the app base URL");
  const daemon = await startTailscaleTestDaemon(baseURL);
  try {
    await preparePairingHost(page, daemon);
    await enableTailscale(page);
    await expectTailscaleAddress(page, daemon.tailscaleAddress);
    await page.screenshot({ path: testInfo.outputPath("devices.png") });

    await test.step("While its status loads, the row never shows Tailscale off", async () => {
      const address = daemon.tailscaleAddress;
      await expectTailscaleRowLoadsOn(page, address, () => preparePairingHost(page, daemon));
      await expectTailscaleRowLoadsOn(page, address, () => openSetupMobileStep(page, daemon));
      const restoreSpeed = await slowConnectionToHost(page, daemon.port, 300);
      await expectTailscaleRowLoadsOn(page, address, () => openSetupMobileStep(page, daemon));
      await expectTailscaleRowLoadsOn(page, address, () => preparePairingHost(page, daemon));
      await test.step("Turning Tailscale off and back on settles over a slow connection", async () => {
        await disableTailscale(page, address);
        await enableTailscale(page);
        await expectTailscaleAddress(page, address);
      });
      restoreSpeed();
    });

    await disableTailscale(page, daemon.tailscaleAddress);

    await test.step("Over Tailscale, turning it off asks first and Cancel changes nothing", async () => {
      await enableTailscale(page);
      await connectThroughTailscale(page, daemon);
      await cancelTailscaleTurnOff(page, daemon.tailscaleAddress);
    });
    await test.step("Confirming turns it off and cuts this connection", async () => {
      await confirmTailscaleTurnOff(page, daemon.tailscaleAddress);
    });
  } finally {
    await daemon.close();
  }
});

test("refreshes Tailscale availability in place after Tailscale starts", async ({
  page,
  baseURL,
}) => {
  test.skip(process.platform !== "linux", "Uses a second IPv4 loopback address");
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Expected the app base URL");
  const daemon = await startTailscaleTestDaemon(baseURL, { initialAvailable: false });
  const statusPolling = observeDaemonStatusPolling(page, daemon.port);
  try {
    await preparePairingHost(page, daemon);
    await expectTailscaleUnavailable(page);

    await test.step("Refreshing while still unavailable shows progress and stays unavailable", async () => {
      const restoreSpeed = await slowConnectionToHost(page, daemon.port, 250);
      await preparePairingHost(page, daemon);
      await expectTailscaleUnavailable(page);
      await refreshTailscaleAvailability(page);
      await page.getByRole("button", { name: "Refreshing...", exact: true }).waitFor();
      await expectTailscaleUnavailable(page);
      restoreSpeed();
    });

    await test.step("Refreshing after Tailscale starts enables the switch in place", async () => {
      await statusPolling.waitForFreshPollWindow();
      await daemon.setTailscaleAvailable(true);
      const refreshRequest = statusPolling.waitForStatusRequest(1_000);
      await refreshTailscaleAvailability(page);
      await refreshRequest;
      await expectTailscaleAvailable(page, { timeout: 1_000 });
      await enableTailscale(page);
      await expectTailscaleAddress(page, daemon.tailscaleAddress);
      await disableTailscale(page, daemon.tailscaleAddress);
    });

    await test.step("Setup mobile step also refreshes Tailscale availability in place", async () => {
      await daemon.setTailscaleAvailable(false);
      await openSetupMobileStep(page, daemon);
      await expectTailscaleUnavailable(page);
      await statusPolling.waitForFreshPollWindow();
      await daemon.setTailscaleAvailable(true);
      const refreshRequest = statusPolling.waitForStatusRequest(1_000);
      await refreshTailscaleAvailability(page);
      await refreshRequest;
      await expectTailscaleAvailable(page, { timeout: 1_000 });
    });
  } finally {
    await daemon.close();
  }
});
