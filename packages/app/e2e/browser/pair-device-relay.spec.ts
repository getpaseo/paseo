import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  expectPairingOffer,
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

    const qr = page.getByRole("img", { name: "Pairing QR code" });
    await qr.scrollIntoViewIfNeeded();
    // IntersectionObserver rounds fractional sheet/scroll coordinates.
    await expect(qr).toBeInViewport({ ratio: 0.999 });
    const bounds = await qr.evaluate((element) => {
      const tile = element.parentElement;
      if (!tile) throw new Error("Pairing QR tile is missing");
      const qrRect = element.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      return {
        qr: { x: qrRect.x, y: qrRect.y, right: qrRect.right, bottom: qrRect.bottom },
        tile: { x: tileRect.x, y: tileRect.y, right: tileRect.right, bottom: tileRect.bottom },
      };
    });

    expect(bounds.qr.x).toBeGreaterThanOrEqual(bounds.tile.x);
    expect(bounds.qr.y).toBeGreaterThanOrEqual(bounds.tile.y);
    expect(bounds.qr.right).toBeLessThanOrEqual(bounds.tile.right);
    expect(bounds.qr.bottom).toBeLessThanOrEqual(bounds.tile.bottom);
    await page.screenshot({ path: testInfo.outputPath("pairing-compact.png") });
  } finally {
    await daemon.close();
  }
});
