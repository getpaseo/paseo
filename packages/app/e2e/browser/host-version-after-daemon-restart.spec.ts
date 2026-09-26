import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { openHostSection, selectSettingsHost } from "../support/helpers/settings";
import {
  startRestartableHostDaemon,
  type RestartableHostDaemon,
} from "../support/helpers/versioned-host-daemon";

const PREVIOUS_VERSION = "0.8.0";
const UPDATED_VERSION = "0.9.1";
const HOST_LABEL = "Version restart QA";
const NO_RELOAD_MARKER = "before-restart";

interface ReloadMarkerWindow {
  __paseoE2eHostVersionMarker?: string;
}

test.describe.configure({ timeout: 120_000 });

let hostDaemon: RestartableHostDaemon | null = null;

test.afterEach(async () => {
  await hostDaemon?.dispose();
  hostDaemon = null;
});

test("host page shows the restarted daemon's version without reloading", async ({ page }) => {
  const host = await startRestartableHostDaemon(PREVIOUS_VERSION);
  hostDaemon = host;

  await test.step("the connected host reports its current daemon version", async () => {
    await openHostPage(page, host);
    await expect(hostIdentity(page)).toContainText("Online");
    await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toBeVisible();
    await markPageForNoReloadCheck(page, NO_RELOAD_MARKER);
  });

  await test.step("the host daemon restarts on the new version", async () => {
    await host.restartWithVersion(UPDATED_VERSION);
  });

  await test.step("the host page badge follows the new version", async () => {
    await expect(hostVersionBadge(page, UPDATED_VERSION)).toBeVisible({ timeout: 30_000 });
    await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toHaveCount(0);
    await expectNoReloadSinceMarker(page);
  });
});

async function openHostPage(page: Page, host: RestartableHostDaemon): Promise<void> {
  await gotoAppShell(page);
  await addConnectedHostAndReload(page, {
    serverId: host.serverId,
    label: HOST_LABEL,
    port: host.port,
  });
  await openSettings(page);
  await selectSettingsHost(page, host.serverId);
  await openHostSection(page, host.serverId, "host");
}

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
