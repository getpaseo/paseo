import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { seedSavedSettingsHosts } from "../support/helpers/settings";

async function setTabVisibility(page: Page, visibility: DocumentVisibilityState): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

async function openHostOverview(page: Page, daemon: IsolatedHostDaemon): Promise<void> {
  await page.goto("/");
  await seedSavedSettingsHosts(page, [
    {
      serverId: daemon.serverId,
      label: "Reconnect QA",
      endpoint: `127.0.0.1:${daemon.port}`,
    },
  ]);
  await page.goto(`/settings/hosts/${daemon.serverId}/host`);
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
}

async function restartHostWhileHidden(page: Page, daemon: IsolatedHostDaemon): Promise<void> {
  const reconnectedSocket = page.waitForEvent("websocket", {
    timeout: 30_000,
    predicate: (socket) => new URL(socket.url()).port === String(daemon.port),
  });
  await daemon.restart();
  await reconnectedSocket;
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
}

test("a hidden tab reconnects after daemon restart and stays connected on refocus", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const daemon = await startIsolatedHostDaemon("background-reconnect");
  try {
    await openHostOverview(page, daemon);
    await page.screenshot({ path: testInfo.outputPath("before-hide.png") });
    await setTabVisibility(page, "hidden");
    await restartHostWhileHidden(page, daemon);
    await page.screenshot({ path: testInfo.outputPath("reconnected-while-hidden.png") });
    await setTabVisibility(page, "visible");
    await expect(page.getByText("Online", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("reconnected-after-refocus.png") });
  } finally {
    await daemon.close();
  }
});
