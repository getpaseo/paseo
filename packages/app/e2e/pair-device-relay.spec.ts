import { expect, test } from "./fixtures";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./helpers/isolated-host-daemon";
import {
  closePairDeviceModal,
  declineRelay,
  enableRelayAndExpectFailure,
  enableRelayAndExpectOffer,
  expectDaemonPidUnchanged,
  expectPairingOffer,
  expectPairingDisconnected,
  expectRelayUpdateRequired,
  expectRelayConsent,
  openPairDeviceModal,
  openPairDeviceFromHome,
  openRelaySecurityDocs,
  prepareLocalPairingHost,
  reloadAndOpenPairDevice,
  retryRelayAndExpectFailure,
  switchPairDeviceToHost,
} from "./helpers/pair-device";

test.describe("local device relay pairing", () => {
  let relayOffDaemon: IsolatedHostDaemon;
  let relayEnableDaemon: IsolatedHostDaemon;
  let relayOverrideDaemon: IsolatedHostDaemon;
  let relayEnabledDaemon: IsolatedHostDaemon;

  test.beforeAll(async () => {
    [relayOffDaemon, relayEnableDaemon, relayOverrideDaemon, relayEnabledDaemon] =
      await Promise.all([
        startIsolatedHostDaemon("pair-device-relay-off", {
          mutableRelay: { enabled: false },
        }),
        startIsolatedHostDaemon("pair-device-relay-enable", {
          mutableRelay: { enabled: false },
        }),
        startIsolatedHostDaemon("pair-device-relay-override"),
        startIsolatedHostDaemon("pair-device-relay-enabled", {
          mutableRelay: { enabled: true },
        }),
      ]);
  });

  test.afterAll(async () => {
    await Promise.all([
      relayOffDaemon.close(),
      relayEnableDaemon.close(),
      relayOverrideDaemon.close(),
      relayEnabledDaemon.close(),
    ]);
  });

  test("asks for consent and creates no QR when declined", async ({ page }) => {
    await prepareLocalPairingHost(page, relayOffDaemon);
    await openPairDeviceModal(page);
    await expectRelayConsent(page);
    await declineRelay(page);
    await openPairDeviceModal(page);
    await expectRelayConsent(page);
  });

  test("opens relay security documentation through the desktop opener", async ({ page }) => {
    await prepareLocalPairingHost(page, relayOffDaemon);
    await openPairDeviceModal(page);
    await openRelaySecurityDocs(page);
  });

  test("opens the same relay consent dialog from the home screen", async ({ page }) => {
    await prepareLocalPairingHost(page, relayOffDaemon);
    await openPairDeviceFromHome(page);
    const modal = page.getByTestId("open-project-pair-device-modal");
    await expect(modal.getByText("Enable relay?", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Enable relay", exact: true })).toBeVisible();
  });

  test("shows an actionable error when the daemon disconnects", async ({ page }) => {
    const daemon = await startIsolatedHostDaemon("pair-device-disconnect", {
      mutableRelay: { enabled: false },
    });
    try {
      await prepareLocalPairingHost(page, daemon);
      await openPairDeviceModal(page);
      await expectRelayConsent(page);
      await daemon.close();
      await expectPairingDisconnected(page);
    } finally {
      await daemon.close();
    }
  });

  test("returns to Connections when the host picker leaves the local daemon", async ({ page }) => {
    await prepareLocalPairingHost(page, relayOffDaemon, [
      {
        serverId: relayEnabledDaemon.serverId,
        label: "Remote pairing host",
        endpoint: `127.0.0.1:${relayEnabledDaemon.port}`,
      },
    ]);
    await switchPairDeviceToHost(page, relayEnabledDaemon.serverId);
  });

  test("enables relay live and keeps the saved offer after reload", async ({ page }) => {
    const daemonPid = relayEnableDaemon.getPid();
    await prepareLocalPairingHost(page, relayEnableDaemon);
    await openPairDeviceModal(page);
    await enableRelayAndExpectOffer(page);
    expectDaemonPidUnchanged(daemonPid, relayEnableDaemon.getPid());
    await closePairDeviceModal(page);
    await reloadAndOpenPairDevice(page);
    await expectPairingOffer(page);
  });

  test("keeps consent actionable when a launch override rejects enable", async ({ page }) => {
    await prepareLocalPairingHost(page, relayOverrideDaemon);
    await openPairDeviceModal(page);
    await expectRelayConsent(page);
    await enableRelayAndExpectFailure(page);
    await retryRelayAndExpectFailure(page);
  });

  test("shows an offer immediately when relay is already enabled", async ({ page }) => {
    await prepareLocalPairingHost(page, relayEnabledDaemon);
    await openPairDeviceModal(page);
    await expectPairingOffer(page);
  });

  test("asks for a host update when live relay config is unsupported", async ({
    page,
    relayConfigOutdatedDaemon,
  }) => {
    await prepareLocalPairingHost(page, relayConfigOutdatedDaemon);
    await openPairDeviceModal(page);
    await expectRelayUpdateRequired(page);
  });
});
