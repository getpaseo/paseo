import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { test } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

async function startTestPages(): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/copy") {
      response.end(
        '<title>Copy page</title><p id="text" style="font:32px sans-serif;margin:20px">Paseo copy check</p>' +
          '<button id="copy" style="font:24px sans-serif;margin:20px" ' +
          "onclick=\"navigator.clipboard.writeText('from the page button')\">Copy</button>",
      );
      return;
    }
    if (request.url === "/tall") {
      response.end(
        '<title>Tall page</title><div style="height:5000px">top</div>' +
          "<script>addEventListener('scroll', () => { document.title = 'Scrolled'; });</script>",
      );
      return;
    }
    setTimeout(() => response.end("<title>Slow page</title><h1>Slow page</h1>"), 3_000);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, server };
}

test("a new daemon browser tab opens once, even while its page is still loading", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const slow = await startTestPages();
  const seeded = await seedWorkspace({ repoPrefix: "remote-browser-tabs-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "remote-browser-warmup",
  });
  try {
    const warmup = await client.executeRemoteBrowserCommand({
      workspaceId: seeded.workspaceId,
      command: { command: "new_tab", args: {} },
    });
    if (!warmup.ok || warmup.result.command !== "new_tab") {
      throw new Error("The daemon did not initialize the browser context");
    }
    const closed = await client.executeRemoteBrowserCommand({
      workspaceId: seeded.workspaceId,
      command: { command: "close_tab", args: { browserId: warmup.result.browserId } },
    });
    expect(closed.ok).toBe(true);
    await page.addInitScript((startUrl) => {
      localStorage.setItem(
        "workspace-browser-store",
        JSON.stringify({ state: { browsersById: {}, startUrl }, version: 0 }),
      );
    }, slow.url);
    await page.goto(buildHostWorkspaceRoute(getServerId(), seeded.workspaceId));
    await waitForWorkspaceTabsVisible(page);
    const panel = await openCommandCenter(page);
    await panel.getByRole("textbox").fill("New browser");
    await page.keyboard.press("Enter");

    const browserTabs = page.locator('[data-testid^="workspace-tab-browser_"]');
    await expect(browserTabs.first()).toBeVisible({ timeout: 15_000 });
    const counts: number[] = [];
    for (let sample = 0; sample < 20; sample += 1) {
      counts.push(await browserTabs.count());
      await page.waitForTimeout(200);
    }
    expect(Math.max(...counts)).toBe(1);
    await expect(browserTabs.first()).toContainText("Slow page", { timeout: 60_000 });
  } finally {
    await client.close();
    await seeded.cleanup();
    slow.server.close();
  }
});

test("closing a daemon tab removes its mirror after reload and preserves the user's browser", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pages = await startTestPages();
  const seeded = await seedWorkspace({ repoPrefix: "remote-browser-close-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "remote-browser-close",
  });
  try {
    await page.addInitScript((startUrl) => {
      if (!localStorage.getItem("workspace-browser-store")) {
        localStorage.setItem(
          "workspace-browser-store",
          JSON.stringify({ state: { browsersById: {}, startUrl }, version: 0 }),
        );
      }
    }, `${pages.url}copy`);
    await page.goto(buildHostWorkspaceRoute(getServerId(), seeded.workspaceId));
    const panel = await openCommandCenter(page);
    await panel.getByRole("textbox").fill("New browser");
    await page.keyboard.press("Enter");
    const browserTabs = page.locator('[data-testid^="workspace-tab-browser_"]');
    await expect(browserTabs).toHaveCount(1);
    await expect(browserTabs.first()).toContainText("Copy page", { timeout: 20_000 });

    const created = await client.executeRemoteBrowserCommand({
      workspaceId: seeded.workspaceId,
      command: { command: "new_tab", args: { url: `${pages.url}tall` } },
    });
    if (!created.ok || created.result.command !== "new_tab") {
      throw new Error("The daemon did not create the mirror tab");
    }
    await expect(browserTabs).toHaveCount(2, { timeout: 15_000 });
    const closed = await client.executeRemoteBrowserCommand({
      workspaceId: seeded.workspaceId,
      command: { command: "close_tab", args: { browserId: created.result.browserId } },
    });
    expect(closed.ok).toBe(true);
    await expect(browserTabs).toHaveCount(1, { timeout: 15_000 });
    await expect(browserTabs.first()).toContainText("Copy page");
    await page.reload();
    await expect(browserTabs).toHaveCount(1, { timeout: 15_000 });
    await expect(browserTabs.first()).toContainText("Copy page");
  } finally {
    await client.close();
    await seeded.cleanup();
    pages.server.close();
  }
});

test("the trackpad scrolls a daemon browser page", async ({ page }) => {
  test.setTimeout(90_000);
  const pages = await startTestPages();
  const seeded = await seedWorkspace({ repoPrefix: "remote-browser-wheel-" });
  try {
    await page.addInitScript((startUrl) => {
      localStorage.setItem(
        "workspace-browser-store",
        JSON.stringify({ state: { browsersById: {}, startUrl }, version: 0 }),
      );
    }, `${pages.url}tall`);
    await page.goto(buildHostWorkspaceRoute(getServerId(), seeded.workspaceId));
    const panel = await openCommandCenter(page);
    await panel.getByRole("textbox").fill("New browser");
    await page.keyboard.press("Enter");

    const browserTab = page.locator('[data-testid^="workspace-tab-browser_"]').first();
    await expect(browserTab).toContainText("Tall page", { timeout: 20_000 });
    const frame = page.locator('[data-testid^="remote-browser-frame-"]').first();
    await frame.hover();
    await page.mouse.wheel(0, 800);
    await expect(browserTab).toContainText("Scrolled", { timeout: 10_000 });
  } finally {
    await seeded.cleanup();
    pages.server.close();
  }
});

test("text selected in a daemon browser page copies to this device", async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pages = await startTestPages();
  const seeded = await seedWorkspace({ repoPrefix: "remote-browser-copy-" });
  try {
    await page.addInitScript((startUrl) => {
      localStorage.setItem(
        "workspace-browser-store",
        JSON.stringify({ state: { browsersById: {}, startUrl }, version: 0 }),
      );
    }, `${pages.url}copy`);
    await page.goto(buildHostWorkspaceRoute(getServerId(), seeded.workspaceId));
    const panel = await openCommandCenter(page);
    await panel.getByRole("textbox").fill("New browser");
    await page.keyboard.press("Enter");
    const browserTab = page.locator('[data-testid^="workspace-tab-browser_"]').first();
    await expect(browserTab).toContainText("Copy page", { timeout: 20_000 });
    const frame = page.locator('[data-testid^="remote-browser-frame-"]').first();
    const box = await frame.boundingBox();
    if (!box) throw new Error("no frame");

    await page.mouse.move(box.x + 22, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 330, box.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.keyboard.press("ControlOrMeta+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
      .toContain("Paseo copy");

    await page.mouse.click(box.x + 60, box.y + 110);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
      .toBe("from the page button");
  } finally {
    await seeded.cleanup();
    pages.server.close();
  }
});
