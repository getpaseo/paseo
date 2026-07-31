import { expect, test } from "./fixtures";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./helpers/isolated-host-daemon";
import { connectDaemonClient } from "./helpers/daemon-client-loader";
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
  observePairingOfferRequests,
  prepareLocalPairingHost,
  reloadAndOpenPairDevice,
  retryRelayAndExpectFailure,
  switchPairDeviceToHost,
} from "./helpers/pair-device";

interface RelayConfigDaemonClient {
  close(): Promise<void>;
  connect(): Promise<void>;
  patchDaemonConfig(config: { relay: { enabled: boolean } }): Promise<unknown>;
}

test.describe("local device relay pairing", () => {
  let relayOffDaemon: IsolatedHostDaemon;
  let relayEnableDaemon: IsolatedHostDaemon;
  let relayOverrideDaemon: IsolatedHostDaemon;
  let relayEnabledDaemon: IsolatedHostDaemon;
  let invalidRelayDaemon: IsolatedHostDaemon;

  test.beforeAll(async () => {
    [
      relayOffDaemon,
      relayEnableDaemon,
      relayOverrideDaemon,
      relayEnabledDaemon,
      invalidRelayDaemon,
    ] = await Promise.all([
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
      startIsolatedHostDaemon("pair-device-relay-invalid", {
        mutableRelay: { enabled: false, endpoint: "invalid-endpoint" },
      }),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([
      relayOffDaemon.close(),
      relayEnableDaemon.close(),
      relayOverrideDaemon.close(),
      relayEnabledDaemon.close(),
      invalidRelayDaemon.close(),
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

  test("pairs a device through the selected remote host", async ({ page }) => {
    await prepareLocalPairingHost(page, relayOffDaemon, [
      {
        serverId: relayEnabledDaemon.serverId,
        label: "Remote pairing host",
        endpoint: `127.0.0.1:${relayEnabledDaemon.port}`,
      },
    ]);
    await switchPairDeviceToHost(page, relayEnabledDaemon.serverId);
    await openPairDeviceModal(page);
    await expectPairingOffer(page);
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

  test("keeps consent actionable when relay transport startup fails", async ({ page }) => {
    await prepareLocalPairingHost(page, invalidRelayDaemon);
    await openPairDeviceModal(page);
    await expectRelayConsent(page);
    await enableRelayAndExpectFailure(page, "Invalid host:port");
    await retryRelayAndExpectFailure(page, "Invalid host:port");
  });

  test("shows an offer immediately when relay is already enabled", async ({ page }) => {
    await prepareLocalPairingHost(page, relayEnabledDaemon);
    await openPairDeviceModal(page);
    await expectPairingOffer(page);
  });

  test("refreshes the mounted offer when another client disables relay", async ({ page }) => {
    const daemon = await startIsolatedHostDaemon("pair-device-live-config-push", {
      mutableRelay: { enabled: true },
    });
    const client = await connectDaemonClient<RelayConfigDaemonClient>({
      clientIdPrefix: "pair-device-live-config-push",
      port: daemon.port,
    });
    try {
      await prepareLocalPairingHost(page, daemon);
      await openPairDeviceModal(page);
      await expectPairingOffer(page);
      await client.patchDaemonConfig({ relay: { enabled: false } });
      await expectRelayConsent(page);
    } finally {
      await client.close();
      await daemon.close();
    }
  });

  test("asks for a host update when live relay config is unsupported", async ({
    page,
    relayConfigOutdatedDaemon,
  }) => {
    const expectNoUnsupportedRequest = observePairingOfferRequests(page, relayConfigOutdatedDaemon);
    await prepareLocalPairingHost(page, relayConfigOutdatedDaemon);
    await openPairDeviceModal(page);
    await expectRelayUpdateRequired(page);
    expectNoUnsupportedRequest();
  });
});
