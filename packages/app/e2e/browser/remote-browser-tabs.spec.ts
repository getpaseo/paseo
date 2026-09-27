import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { test } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// The daemon lists a new tab while it still waits for the page, so a slow page
// is what used to open the same daemon tab twice.
async function startSlowPage(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Slow page</title><h1>Slow page</h1>");
    }, 3_000);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, server };
}

test("a new daemon browser tab opens once, even while its page is still loading", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const slow = await startSlowPage();
  const seeded = await seedWorkspace({ repoPrefix: "remote-browser-tabs-" });
  try {
    await page.addInitScript((startUrl) => {
      localStorage.setItem(
        "workspace-browser-store",
        JSON.stringify({ state: { browsersById: {}, startUrl }, version: 0 }),
      );
    }, slow.url);
    await page.goto(buildHostWorkspaceRoute(getServerId(), seeded.workspaceId));
    const panel = await openCommandCenter(page);
    await panel.getByRole("textbox").fill("New browser");
    await page.keyboard.press("Enter");

    const browserTabs = page.locator('[data-testid^="workspace-tab-browser_"]');
    await expect(browserTabs.first()).toBeVisible({ timeout: 15_000 });
    await expect(browserTabs.first()).toContainText("Slow page", { timeout: 20_000 });
    // Several tab listings run while the page loads; none may adopt the tab again.
    await page.waitForTimeout(3_000);
    await expect(browserTabs).toHaveCount(1);
  } finally {
    await seeded.cleanup();
    slow.server.close();
  }
});
