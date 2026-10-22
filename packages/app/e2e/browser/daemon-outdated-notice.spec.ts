import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, metroTest as test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";

// 0.8.0 predates terminalsSurviveRestart and supports daemonSelfUpdate.
const PUBLISHED_DAEMON_VERSION = "0.8.0";
const COMPACT = { width: 390, height: 844 };

// Opens the app against a published 0.8.0 daemon, with the developer daemon blocked.
async function withOutdatedDaemon(page: Page, run: () => Promise<void>): Promise<void> {
  const serverId = `srv_daemon_outdated_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const daemon = await startIsolatedHostDaemon(serverId, {
    publishedVersion: PUBLISHED_DAEMON_VERSION,
  });

  try {
    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${daemon.port}`,
      nowIso: new Date().toISOString(),
    });
    await page.route(/:6767\b/, (route) => route.abort());
    await page.routeWebSocket(/:6767\b/, async (webSocket) => {
      await webSocket.close({ code: 1008, reason: "Blocked developer daemon during e2e." });
    });
    await page.addInitScript(
      ({ seededHost }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
      },
      { seededHost: host },
    );

    await gotoAppShell(page);
    await run();
  } finally {
    await daemon.close();
  }
}

async function expectOutdatedNotice(page: Page): Promise<void> {
  const callout = page.getByTestId("daemon-outdated-callout").first();
  await expect(callout).toBeVisible({ timeout: 30_000 });
  await expect(callout).toContainText("Daemon out of date");
  await expect(callout).toContainText(`daemon v${PUBLISHED_DAEMON_VERSION}`);
  await expect(callout).toContainText("Updating restarts the daemon and closes open terminals.");
  const update = page.getByTestId("daemon-outdated-callout-update").first();
  await expect(update).toBeVisible();
  await expect(update).toBeEnabled();
}

test("sidebar shows an update notice when the active host's daemon is older than the app", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await withOutdatedDaemon(page, () => expectOutdatedNotice(page));
});

test("compact sidebar shows the update notice, which is a native callout", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(COMPACT);
  await withOutdatedDaemon(page, async () => {
    await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
    await expectOutdatedNotice(page);
  });
});
