import { expect, test as base } from "../support/fixtures";
import type { Page, TestInfo } from "@playwright/test";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { seedSavedSettingsHosts } from "../support/helpers/settings";

const test = base.extend<{ reconnectHost: IsolatedHostDaemon }>({
  reconnectHost: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const daemon = await startIsolatedHostDaemon("background-reconnect");
    try {
      await provide(daemon);
    } finally {
      await daemon.close();
    }
  },
});

test.describe.configure({ timeout: 120_000 });

async function captureHost({
  page,
  testInfo,
  name,
}: {
  page: Page;
  testInfo: TestInfo;
  name: string;
}): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function refocusConnectedTab(page: Page): Promise<void> {
  await setTabVisibility(page, "visible");
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
}

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
  reconnectHost,
}, testInfo) => {
  await openHostOverview(page, reconnectHost);
  await captureHost({ page, testInfo, name: "before-hide" });
  await setTabVisibility(page, "hidden");
  await restartHostWhileHidden(page, reconnectHost);
  await captureHost({ page, testInfo, name: "reconnected-while-hidden" });
  await refocusConnectedTab(page);
  await captureHost({ page, testInfo, name: "reconnected-after-refocus" });
});
