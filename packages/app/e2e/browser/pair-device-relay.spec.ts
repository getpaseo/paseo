import { test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
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
