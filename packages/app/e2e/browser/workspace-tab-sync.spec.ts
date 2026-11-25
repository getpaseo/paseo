import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import { hideDeveloperToasts } from "../support/developer-ui.mjs";
import { expect, test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace, pressNewTabShortcut } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

async function secondProfile(browser: Browser, page: Page) {
  const storageState = await page.context().storageState();
  for (const origin of storageState.origins) {
    origin.localStorage = origin.localStorage.filter(({ name }) =>
      ["@paseo:daemon-registry", "@paseo:e2e", "@paseo:onboarding"].includes(name),
    );
  }
  const context = await browser.newContext({ storageState, viewport: page.viewportSize() });
  const observer = await context.newPage();
  await observer.route(/:6767\b/, (route) => route.abort());
  await observer.routeWebSocket(/:6767\b/, (ws) => ws.close());
  await hideDeveloperToasts(observer);
  return { context, observer };
}

function fileTab(page: Page, file: string) {
  return page.getByTestId(`workspace-tab-file_${file}`).filter({ visible: true });
}

function fileOrder(page: Page) {
  return page
    .locator('[data-testid^="workspace-tab-file_"]')
    .filter({ visible: true })
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
}

async function dragAfter(first: Locator, second: Locator) {
  const source = await first.boundingBox();
  const destination = await second.boundingBox();
  if (!source || !destination) throw new Error("Need two visible tab chips");
  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const { mouse } = first.page();
  await mouse.move(start.x, start.y);
  await mouse.down();
  await mouse.move(start.x + 12, start.y);
  await mouse.move(destination.x + destination.width - 3, destination.y + destination.height / 2, {
    steps: 20,
  });
  await mouse.up();
}

test("file tabs open, reorder, close, and survive reload across browser profiles", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const seed = await seedWorkspace({ repoPrefix: "tab-sync-" });
  try {
    await writeFile(path.join(seed.repoPath, "other.md"), "# Other\n");
    await gotoWorkspace(page, seed.workspaceId);
    const { context, observer } = await secondProfile(browser, page);
    try {
      await observer.goto(page.url());
      await expect(
        observer.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
      ).toBeVisible();
      await openFileExplorer(page);
      await openFileFromExplorer(page, "README.md");
      await expect(fileTab(observer, "README.md")).toBeVisible();
      // A new local launcher keeps the next Explorer preview from replacing README.md.
      await pressNewTabShortcut(page);
      await openFileFromExplorer(page, "other.md");
      await expect(fileTab(observer, "other.md")).toBeVisible({ timeout: 20_000 });
      const names = ["README.md", "other.md"].map((file) => `workspace-tab-file_${file}`);
      await expect.poll(() => fileOrder(page)).toEqual(names);
      await expect.poll(() => fileOrder(observer)).toEqual(names);
      await observer.screenshot({ path: testInfo.outputPath("tab-sync-before.png") });

      await dragAfter(fileTab(page, "README.md"), fileTab(page, "other.md"));
      await expect.poll(() => fileOrder(page)).toEqual([names[1], names[0]]);
      await expect.poll(() => fileOrder(observer)).toEqual([names[1], names[0]]);
      await observer.screenshot({ path: testInfo.outputPath("tab-sync-reordered.png") });

      await fileTab(page, "README.md").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Close", exact: true }).click();
      await expect(fileTab(observer, "README.md")).toHaveCount(0);
      await observer.reload();
      await expect.poll(() => fileOrder(observer)).toEqual([names[1]]);
      await observer.screenshot({ path: testInfo.outputPath("tab-sync-reloaded.png") });
    } finally {
      await context.close();
    }
  } finally {
    await seed.cleanup();
  }
});

test("split mode all propagates a split to a second browser profile", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const seed = await seedWorkspace({ repoPrefix: "tab-sync-split-" });
  const splitHandle = (client: Page) =>
    client.getByTestId("workspace-split-resize-handle").filter({ visible: true });
  try {
    expect((await seed.client.getDaemonConfig()).config.workspaceSplitSync).toBe("off");
    const { config } = await seed.client.patchDaemonConfig({ workspaceSplitSync: "all" });
    expect(config.workspaceSplitSync).toBe("all");
    await gotoWorkspace(page, seed.workspaceId);
    const { context, observer } = await secondProfile(browser, page);
    try {
      await observer.goto(page.url());
      await expect(
        observer.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(splitHandle(observer)).toHaveCount(0);
      await runWorkspaceActionFromCommandCenter(page, "Split pane right");
      await expect(splitHandle(page)).toHaveCount(1);
      await expect(splitHandle(observer)).toHaveCount(1);
      await observer.screenshot({ path: testInfo.outputPath("tab-sync-split.png") });
    } finally {
      await context.close();
    }
  } finally {
    await seed.client.patchDaemonConfig({ workspaceSplitSync: "off" });
    await seed.cleanup();
  }
});
