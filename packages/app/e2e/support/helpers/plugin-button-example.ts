import type { Locator, TestInfo } from "@playwright/test";
import { test, expect, type Page } from "@playwright/test";
import { copyPluginExample } from "./plugin-fixture";
import { gotoAppShell } from "./app";
import { buildAgentRoute } from "./mock-agent";
import { openCommandCenter } from "./command-center";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { seedWorkspace } from "./seed-client";
import { waitForSettledPosition } from "./sheet-layout";

const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

function headerButtons(page: Page) {
  return page.getByRole("toolbar", { name: "Workspace actions", exact: true }).getByRole("button");
}

async function exampleCommand(page: Page, name: string) {
  await page.setViewportSize(WIDE);
  const panel = await openCommandCenter(page);
  const title = `Button examples: ${name}`;
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  subject: Locator = headerButtons(page),
) {
  await expect(headerButtons(page)).toHaveCount(1);
  await expect(subject).toBeInViewport();
  await waitForSettledPosition(subject);
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  await info.attach(name, { path: file, contentType: "image/png" });
}

async function closeDetails(page: Page) {
  await page.getByRole("button", { name: "Close workspace details", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close workspace details", exact: true }),
  ).toHaveCount(0);
}

export async function withButtonAuthorExample(
  page: Page,
  info: TestInfo,
  run: (buttons: {
    refreshFromHeaderAndComposer(): Promise<void>;
    useMenusAndToggleButtons(): Promise<void>;
    inspectLiveWorkspaceDetails(): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedWorkspace({
    repoPrefix: "button-example-",
    title: "Button examples",
  });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Example agent",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const example = await copyPluginExample("buttons");
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    await page.goto(buildAgentRoute(workspace.workspaceId, agent.id));

    await run({
      refreshFromHeaderAndComposer: () =>
        test.step("icon-only header action and labeled composer action update in place", async () => {
          await exampleCommand(page, "action");
          await headerButtons(page).click();
          await expect(headerButtons(page)).toHaveAccessibleName("Refresh workspace (1)");
          await page.getByRole("button", { name: "Refresh context", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "Refresh context", exact: true }),
          ).toContainText("Refreshed · 2");
          await capture(page, info, "01-actions");
          await page.setViewportSize(COMPACT);
          await capture(page, info, "02-compact-actions");
        }),
      useMenusAndToggleButtons: () =>
        test.step("named menus include separators, nested actions, disabled items, and custom content", async () => {
          await exampleCommand(page, "menu");
          await headerButtons(page).click();
          await expect(
            page.getByRole("menuitem", { name: "Publish (unavailable in example)", exact: true }),
          ).toBeDisabled();
          await capture(
            page,
            info,
            "03-header-menu",
            page.getByRole("menuitem", { name: "Refresh workspace", exact: true }),
          );
          await page.getByRole("menuitem", { name: "Workspace details", exact: true }).click();
          await expect(page.getByText("Button examples", { exact: true }).last()).toBeVisible();
          await closeDetails(page);
          await page.getByRole("button", { name: "Composer tools", exact: true }).click();
          await capture(
            page,
            info,
            "04-composer-menu",
            page.getByRole("menuitem", { name: "Refresh workspace", exact: true }),
          );
          await page.getByRole("menuitem", { name: "Display", exact: true }).click();
          await page.getByRole("menuitem", { name: "Hide example buttons", exact: true }).click();
          await expect(headerButtons(page)).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Composer tools", exact: true }),
          ).toHaveCount(0);
          await exampleCommand(page, "show");
          await exampleCommand(page, "disable");
          await expect(headerButtons(page)).toBeDisabled();
          await expect(
            page.getByRole("button", { name: "Composer tools", exact: true }),
          ).toBeDisabled();
          await capture(page, info, "05-disabled");
          await exampleCommand(page, "enable");
          await page.setViewportSize(COMPACT);
          await headerButtons(page).click();
          await expect(
            page.getByRole("menuitem", { name: "Refresh workspace", exact: true }),
          ).toBeInViewport();
          await capture(
            page,
            info,
            "06-compact-menu",
            page.getByRole("menuitem", { name: "Refresh workspace", exact: true }),
          );
          await page.getByRole("menuitem", { name: "Refresh workspace", exact: true }).click();
        }),
      inspectLiveWorkspaceDetails: () =>
        test.step("custom icons and content react to workspace changes and adapt to sheets", async () => {
          await exampleCommand(page, "popover");
          await headerButtons(page).click();
          await expect(
            page.getByRole("button", { name: "Close workspace details", exact: true }),
          ).toBeVisible();
          await capture(
            page,
            info,
            "07-header-popover",
            page.getByRole("button", { name: "Close workspace details", exact: true }),
          );
          await client.setWorkspaceTitle(workspace.workspaceId, "Renamed from the daemon");
          await expect(
            page.getByText("Renamed from the daemon", { exact: true }).last(),
          ).toBeVisible();
          await closeDetails(page);
          await page.getByRole("button", { name: "Context details", exact: true }).click();
          await capture(
            page,
            info,
            "08-composer-popover",
            page.getByRole("button", { name: "Close workspace details", exact: true }),
          );
          await closeDetails(page);
          await page.setViewportSize(COMPACT);
          await page.getByRole("button", { name: "Context details", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "Close workspace details", exact: true }),
          ).toBeInViewport();
          await capture(
            page,
            info,
            "09-compact-popover",
            page.getByRole("button", { name: "Close workspace details", exact: true }),
          );
          await closeDetails(page);
          await client.disablePlugin("button-examples");
          await expect(headerButtons(page)).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Context details", exact: true }),
          ).toHaveCount(0);
        }),
    });
  } finally {
    await client.removePlugin("button-examples");
    await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
    await workspace.cleanup();
  }
}
