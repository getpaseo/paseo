import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { expectOpenTabCount } from "../support/helpers/sheet";
import {
  closeCompactWorkspaceMenu,
  goBackInMenu,
  menuRow,
  openCompactWorkspaceMenu,
  openRunningScriptPage,
  openScriptsPage,
  runScriptFromScriptsPage,
  scriptRow,
  scriptsMenuRow,
} from "../support/helpers/compact-workspace-scripts";

const labels = {
  long: {
    title: "workspace-with-a-very-long-release-and-investigation-name",
    project: "project-with-a-very-long-customer-integration-name",
  },
  short: { title: "main", project: "Paseo" },
};

async function openNamedWorkspace(page: Page, names: typeof labels.long) {
  const workspace = await seedWorkspace({ repoPrefix: "header-width-", title: names.title });
  try {
    await workspace.client.renameProject(workspace.projectId, names.project);
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Header layout check",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await expect(page.getByTestId("workspace-header-title")).toHaveText(names.title);
    await expect(page.getByTestId("workspace-header-subtitle")).toHaveText(names.project);
    await expect(
      page.getByTestId(`host-badge-${getServerId()}`).filter({ visible: true }),
    ).toHaveCount(1);
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

async function expectHeaderContentsFit(page: Page, info: TestInfo, long: boolean) {
  const menu = page.getByTestId("menu-button").filter({ visible: true });
  const title = page.getByTestId("workspace-header-title");
  const project = page.getByTestId("workspace-header-subtitle");
  const badge = page.getByTestId(`host-badge-${getServerId()}`).filter({ visible: true });
  const trigger = page.getByRole("button", { name: /Switch tabs/ });
  const measure = async () => ({
    menu: await menu.boundingBox(),
    title: await title.boundingBox(),
    project: await project.boundingBox(),
    badge: await badge.boundingBox(),
    icon: await badge.locator("svg").boundingBox(),
    trigger: await trigger.boundingBox(),
    titleTruncated: await title.evaluate((el) => el.scrollWidth > el.clientWidth),
    projectTruncated: await project.evaluate((el) => el.scrollWidth > el.clientWidth),
  });
  await page.screenshot({ path: info.outputPath("header.png") });
  await expect(async () => {
    const bounds = await measure();
    expect(bounds.menu).not.toBeNull();
    expect(bounds.title).not.toBeNull();
    expect(bounds.project).not.toBeNull();
    expect(bounds.badge).not.toBeNull();
    expect(bounds.icon).not.toBeNull();
    expect(bounds.trigger).not.toBeNull();
    // The labels sit between the menu button and the actions without overlapping either.
    expect(bounds.title!.x).toBeGreaterThan(bounds.menu!.x + bounds.menu!.width);
    expect(bounds.project!.x).toBe(bounds.title!.x);
    for (const box of [bounds.title!, bounds.project!, bounds.badge!, bounds.icon!]) {
      expect(box.x + box.width).toBeLessThan(bounds.trigger!.x);
    }
    expect(bounds.project!.width).toBeGreaterThan(20);
    // Long labels truncate instead of squeezing the host icon.
    expect(bounds.icon!.width).toBe(bounds.icon!.height);
    expect(bounds.badge!.x).toBeGreaterThan(bounds.project!.x + bounds.project!.width);
    expect(bounds.titleTruncated).toBe(long);
    expect(bounds.projectTruncated).toBe(long);
  }).toPass({ timeout: 5_000 });
  await info.attach("header-bounds", {
    body: JSON.stringify(await measure(), null, 2),
    contentType: "application/json",
  });
}

for (const width of [320, 390]) {
  for (const kind of ["long", "short"] as const) {
    test(`compact header contains ${kind} labels at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 844 });
      const workspace = await openNamedWorkspace(page, labels[kind]);
      try {
        await expectHeaderContentsFit(page, info, kind === "long");
      } finally {
        await workspace.cleanup();
      }
    });
  }
}

const KEEP_ALIVE = 'node -e "setInterval(() => {}, 1000)"';
const WEB_SERVER =
  "node -e \"require('http').createServer((q, r) => r.end('ok')).listen(process.env.PASEO_PORT)\"";

async function openWorkspaceWithScripts(page: Page) {
  const workspace = await seedWorkspace({
    repoPrefix: "compact-scripts-",
    repo: {
      paseoConfig: {
        scripts: {
          lint: { type: "script", command: KEEP_ALIVE },
          web: { type: "service", command: WEB_SERVER },
        },
      },
    },
  });
  try {
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Scripts menu check",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

test("compact header menu runs, shows, and stops workspace scripts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await openWorkspaceWithScripts(page);
  try {
    await expectOpenTabCount(page, 1);

    await test.step("nothing running: the Scripts row has no value", async () => {
      await openCompactWorkspaceMenu(page);
      await expect(scriptsMenuRow(page)).toHaveAccessibleName("Scripts");
      await closeCompactWorkspaceMenu(page);
    });

    await test.step("a stopped script runs from the Scripts page into a terminal tab", async () => {
      await runScriptFromScriptsPage(page, "lint");
      await expectOpenTabCount(page, 2);
      await openCompactWorkspaceMenu(page);
      await expect(scriptsMenuRow(page)).toHaveAccessibleName(/^Scripts\s*lint$/);
      await closeCompactWorkspaceMenu(page);
    });

    await test.step("two running scripts are counted on the root row", async () => {
      await runScriptFromScriptsPage(page, "web");
      await expectOpenTabCount(page, 3);
      await openCompactWorkspaceMenu(page);
      await expect(scriptsMenuRow(page)).toHaveAccessibleName(/^Scripts\s*2 running$/);
      await closeCompactWorkspaceMenu(page);
    });

    await test.step("stopping a script keeps its page open in the stopped state", async () => {
      await openRunningScriptPage(page, "web");
      await expect(menuRow(page, "View service")).toBeVisible();
      await menuRow(page, "Stop").click();
      await expect(menuRow(page, "Run")).toBeVisible({ timeout: 15_000 });
      await expect(menuRow(page, "Stop")).toHaveCount(0);

      await goBackInMenu(page);
      await expect(scriptRow(page, "web")).toHaveAccessibleName(/^web\s*exit \d+$/);
      await expect(scriptRow(page, "lint")).toHaveAccessibleName(/^lint\s*Running$/);
      await closeCompactWorkspaceMenu(page);
    });

    await test.step("the root row names the one script still running", async () => {
      await openScriptsPage(page);
      await goBackInMenu(page);
      await expect(scriptsMenuRow(page)).toHaveAccessibleName(/^Scripts\s*lint$/);
    });
  } finally {
    await workspace.cleanup();
  }
});
