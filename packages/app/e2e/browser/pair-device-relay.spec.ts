import { test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  expectPairingOffer,
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
