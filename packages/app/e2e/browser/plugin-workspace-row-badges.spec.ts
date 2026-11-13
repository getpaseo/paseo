import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  closeSidebarDisplayPreferences,
  openMobileAgentSidebar,
  openSidebarDisplayPage,
} from "../support/helpers/sidebar";

const PLUGIN_ID = "row-badges-e2e";
const TITLE = "Badge host workspace";

const PLUGIN_SOURCE = `import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";

function Review() {
  return <WorkspaceRowBadge icon="Eye" label="In review" tone="warning" />;
}

function Docs() {
  return <WorkspaceRowBadge icon="BookOpen" label="Docs" />;
}

function IconOnly() {
  return <WorkspaceRowBadge icon="Star" />;
}

function EmptyLabel() {
  return <WorkspaceRowBadge icon="Circle" label="" />;
}

function Quiet() {
  return null;
}

function Broken() {
  throw new Error("badge failed");
}

export default function contribute(client) {
  client.addWorkspaceRowBadgeItem({ id: "review", title: "Review state", icon: "Eye", Component: Review });
  client.addWorkspaceRowBadgeItem({ id: "docs", title: "Docs state", icon: "BookOpen", Component: Docs });
  client.addWorkspaceRowBadgeItem({ id: "icon", title: "Icon state", icon: "Star", Component: IconOnly });
  client.addWorkspaceRowBadgeItem({ id: "empty", title: "Empty label state", icon: "Circle", Component: EmptyLabel });
  client.addWorkspaceRowBadgeItem({ id: "quiet", title: "Quiet state", icon: "Moon", Component: Quiet });
  client.addWorkspaceRowBadgeItem({ id: "broken", title: "Broken state", icon: "Bug", Component: Broken });
  return () => {};
}
`;

// The meta line the badges draw on. Each item sits in one wrapper of its own, so the line is two up.
const LABELS = { review: "In review", docs: "Docs" } as const;

function badgeLine(page: Page, itemId: keyof typeof LABELS) {
  return badge(page, itemId).locator("xpath=../..");
}

function badge(page: Page, itemId: keyof typeof LABELS) {
  return page.getByLabel(LABELS[itemId], { exact: true }).locator("visible=true");
}

async function toggleShowItem(page: Page, label: string, touch: boolean) {
  await openSidebarDisplayPage(page, "sidebar-display-show");
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (touch) {
    await page
      .getByRole("button", { name: "Bottom sheet backdrop", exact: true })
      .click({ position: { x: 5, y: 5 } });
  } else {
    await closeSidebarDisplayPreferences(page);
  }
}

test("a plugin badge shows on workspace rows, hides quietly, and follows its Show toggle", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "row-badges-", title: TITLE });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-row-badges-"));
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), PLUGIN_SOURCE);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoAppShell(page);

    await test.step("the badge draws on the row; a null item and a throwing item draw nothing", async () => {
      await expect(badge(page, "review")).toBeVisible();
      await expect(badge(page, "review")).toContainText("In review");
      // The null and throwing items after them draw nothing, and the line adds nothing of its own.
      await expect(badgeLine(page, "review")).toHaveText("In reviewDocs");
      // An icon-only badge is named by its item's title.
      await expect(
        page.getByLabel("Icon state", { exact: true }).locator("visible=true"),
      ).toBeVisible();
      await expect(
        page.getByLabel("Empty label state", { exact: true }).locator("visible=true"),
      ).toBeVisible();
      await expect(page.getByText(TITLE).first()).toBeVisible();
      await page.screenshot({ path: info.outputPath("wide.png") });
    });

    await test.step("every item has a Show toggle, and switching one off removes only that badge", async () => {
      await openSidebarDisplayPage(page, "sidebar-display-show");
      for (const label of ["Review state", "Quiet state", "Broken state", "Docs state"]) {
        await expect(page.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
      }
      await expect(page.getByTestId("sidebar-plugin-row-badge-items-separator")).toBeVisible();
      await page.screenshot({ path: info.outputPath("show-menu.png") });
      await page.getByRole("menuitem", { name: "Review state", exact: true }).click();
      await closeSidebarDisplayPreferences(page);
      await expect(badge(page, "review")).toHaveCount(0);
      // The first badge is gone, so the next one leads the line without a "·".
      await expect(badgeLine(page, "docs")).toHaveText("Docs");
      await toggleShowItem(page, "Review state", false);
      await expect(badge(page, "review")).toBeVisible();
    });

    await test.step("the badge draws on a compact layout", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openMobileAgentSidebar(page);
      await expect(badge(page, "review")).toBeVisible();
      await page.screenshot({ path: info.outputPath("compact.png") });
      await toggleShowItem(page, "Review state", true);
      await expect(badge(page, "review")).toHaveCount(0);
      await toggleShowItem(page, "Review state", true);
      await expect(badge(page, "review")).toBeVisible();
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await workspace.cleanup();
  }
});
