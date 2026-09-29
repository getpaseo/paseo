import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { openHostSection, selectSettingsHost } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
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
  const otherHostVersion =
    await test.step("the connected host reports its current daemon version", async () => {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: host.serverId,
        label: HOST_LABEL,
        port: host.port,
      });
      const version = await readHelpHostVersion(page, getServerId());
      await expectHelpHostVersion(page, host.serverId, PREVIOUS_VERSION);
      await openHostPage(page, host);
      await expect(hostIdentity(page)).toContainText("Online");
      await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toBeVisible();
      await markPageForNoReloadCheck(page, NO_RELOAD_MARKER);
      return version;
    });

  await test.step("the last known version remains on the host page when the host stops", async () => {
    await host.stop();
    await expect(hostIdentity(page)).toContainText("Error");
    await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toBeVisible();
  });

  await test.step("the host daemon restarts on the new version", async () => {
    await host.restartWithVersion(UPDATED_VERSION);
  });

  await test.step("the host page badge follows the new version", async () => {
    await expect(hostVersionBadge(page, UPDATED_VERSION)).toBeVisible({ timeout: 30_000 });
    await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toHaveCount(0);
    await page.getByRole("button", { name: "Back" }).click();
    await expectHelpHostVersion(page, host.serverId, UPDATED_VERSION);
    expect(await readHelpHostVersion(page, getServerId())).toBe(otherHostVersion);
    await expectNoReloadSinceMarker(page);
  });
});

async function readHelpHostVersion(page: Page, serverId: string): Promise<string> {
  await page.getByTestId("sidebar-help").click();
  const row = page.getByTestId(`sidebar-help-host-version-${serverId}`);
  await expect(row).toBeVisible();
  const text = await row.innerText();
  await page.keyboard.press("Escape");
  return text;
}

async function expectHelpHostVersion(page: Page, serverId: string, version: string): Promise<void> {
  const text = await readHelpHostVersion(page, serverId);
  expect(text).toContain(`v${version}`);
}

async function openHostPage(page: Page, host: RestartableHostDaemon): Promise<void> {
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
