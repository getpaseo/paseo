import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { getAvailableHostDaemonPort } from "../support/helpers/isolated-host-daemon";
import { openHostSection, selectSettingsHost } from "../support/helpers/settings";
import {
  startVersionedHostDaemon,
  waitForPortReleased,
  type VersionedHostDaemon,
} from "../support/helpers/versioned-host-daemon";

const PREVIOUS_VERSION = "0.8.0";
const UPDATED_VERSION = "0.9.1";
const HOST_LABEL = "Version restart QA";
const NO_RELOAD_MARKER = "before-restart";

interface ReloadMarkerWindow {
  __paseoE2eHostVersionMarker?: string;
}

test.describe.configure({ timeout: 120_000 });

test("host page shows the restarted daemon's version without reloading", async ({
  page,
}, testInfo) => {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-e2e-version-restart-"));
  const port = await getAvailableHostDaemonPort();
  let daemon: VersionedHostDaemon | null = null;
  try {
    const originalDaemon = await startVersionedHostDaemon({
      version: PREVIOUS_VERSION,
      port,
      paseoHomeRoot,
    });
    daemon = originalDaemon;

    await test.step("the connected host reports its current daemon version", async () => {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: originalDaemon.serverId,
        label: HOST_LABEL,
        port,
      });
      await openSettings(page);
      await selectSettingsHost(page, originalDaemon.serverId);
      await openHostSection(page, originalDaemon.serverId, "host");
      await expect(hostIdentity(page)).toContainText("Online");
      await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toBeVisible();
      await markPageForNoReloadCheck(page, NO_RELOAD_MARKER);
      await page.screenshot({
        path: testInfo.outputPath("before-restart.png"),
        fullPage: true,
      });
    });

    await test.step("a replacement daemon starts on the same port and home", async () => {
      await originalDaemon.stop();
      daemon = null;
      await waitForPortReleased(port);
      daemon = await startVersionedHostDaemon({
        version: UPDATED_VERSION,
        port,
        paseoHomeRoot,
      });
      expect(daemon.serverId).toBe(originalDaemon.serverId);
    });

    await test.step("the host page badge follows the new version", async () => {
      await expect(hostVersionBadge(page, UPDATED_VERSION)).toBeVisible({ timeout: 30_000 });
      await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toHaveCount(0);
      await expectNoReloadSinceMarker(page);
      await page.screenshot({
        path: testInfo.outputPath("after-restart.png"),
        fullPage: true,
      });
    });
  } finally {
    await daemon?.stop();
    await rm(paseoHomeRoot, { recursive: true, force: true });
  }
});

function hostIdentity(page: Page) {
  return page.getByTestId("host-page-identity");
}

function hostVersionBadge(page: Page, version: string) {
  return hostIdentity(page).getByText(`v${version}`, { exact: true });
}

async function markPageForNoReloadCheck(page: Page, marker: string): Promise<void> {
  // The marker has to cross into the page as an argument: the callback runs in the browser, so a
  // captured Node-side constant is not defined there.
  await page.evaluate((value) => {
    (window as typeof window & ReloadMarkerWindow).__paseoE2eHostVersionMarker = value;
  }, marker);
}

async function expectNoReloadSinceMarker(page: Page): Promise<void> {
  const marker = await page.evaluate(
    () => (window as typeof window & ReloadMarkerWindow).__paseoE2eHostVersionMarker ?? null,
  );
  expect(marker).toBe(NO_RELOAD_MARKER);
}
