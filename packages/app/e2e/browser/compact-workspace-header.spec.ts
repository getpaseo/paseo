import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";

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
  const title = page.getByTestId("workspace-header-title");
  const project = page.getByTestId("workspace-header-subtitle");
  const badge = page.getByTestId(`host-badge-${getServerId()}`).filter({ visible: true });
  const trigger = page.getByRole("button", { name: /Switch tabs/ });
  const measure = async () => ({
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
    expect(bounds.title).not.toBeNull();
    expect(bounds.project).not.toBeNull();
    expect(bounds.badge).not.toBeNull();
    expect(bounds.icon).not.toBeNull();
    expect(bounds.trigger).not.toBeNull();
    // Approved geometry: 12px outside margin, 46px leading island, 8px title gap.
    expect(bounds.title!.x).toBe(66);
    expect(bounds.project!.x).toBe(bounds.title!.x);
    expect(bounds.trigger!.width).toBe(32);
    expect(bounds.trigger!.height).toBe(32);
    // The action frame starts 7px inside its island; preserve the 8px gap before it.
    const contentRight = bounds.trigger!.x - 15;
    for (const box of [bounds.title!, bounds.project!, bounds.badge!, bounds.icon!]) {
      expect(box.x + box.width).toBeLessThanOrEqual(contentRight + 1);
    }
    expect(bounds.project!.width).toBeGreaterThan(20);
    expect(bounds.icon!.width).toBe(12);
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
