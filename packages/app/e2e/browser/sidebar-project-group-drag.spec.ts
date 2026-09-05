import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openProjectContextMenu } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a visible drag target");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Picks a project row up with the mouse and drops it on `target`. The seven-pixel nudge clears
 * the six-pixel activation distance; the "New group" zone appearing proves the drag is live
 * before the pointer aims anywhere.
 */
async function dragProjectRowTo(page: Page, projectViewKey: string, target: Locator) {
  const source = await center(page.getByTestId(`sidebar-project-row-${projectViewKey}`));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y + 7);
  await expect(page.getByTestId("sidebar-project-drop-new-group")).toBeVisible();
  const destination = await center(target);
  await page.mouse.move(destination.x, destination.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("sidebar-project-drop-new-group")).toHaveCount(0);
}

async function expectGroupRowOrder(page: Page, groupKey: string, projectViewKeys: string[]) {
  const rows = page
    .getByTestId(`sidebar-project-group-${groupKey}`)
    .locator('[data-testid^="sidebar-project-row-"]');
  const rowTestIds = () =>
    rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
  await expect
    .poll(rowTestIds)
    .toEqual(projectViewKeys.map((viewKey) => `sidebar-project-row-${viewKey}`));
}

async function expectProjectInGroup(page: Page, groupKey: string, projectViewKey: string) {
  const section = page.getByTestId(`sidebar-project-group-${groupKey}`);
  await expect(section.getByTestId(`sidebar-project-row-${projectViewKey}`)).toBeVisible();
}

async function expectProjectUngrouped(page: Page, projectViewKey: string) {
  const list = page.getByTestId("sidebar-ungrouped-project-list");
  await expect(list.getByTestId(`sidebar-project-row-${projectViewKey}`)).toBeVisible();
}

async function createGroupInModal(page: Page, name: string) {
  const modal = page.getByTestId("project-group-create-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("project-group-create-input").fill(name);
  await page.getByTestId("project-group-create-confirm").click();
  await expect(modal).toHaveCount(0);
}

/** The group sections in document order, by key. Only whole sections carry these ids. */
async function expectGroupOrder(page: Page, groupKeys: string[]) {
  const selector = groupKeys
    .map((groupKey) => `[data-testid="sidebar-project-group-${groupKey}"]`)
    .join(", ");
  const sectionTestIds = () =>
    page
      .locator(selector)
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
  await expect
    .poll(sectionTestIds)
    .toEqual(groupKeys.map((groupKey) => `sidebar-project-group-${groupKey}`));
}

/**
 * Picks a group up by its header and drops it on the top edge of `targetGroupKey`'s section,
 * so the dragged section's centre ends up above the target's and the target yields its place.
 */
async function dragGroupHeaderAbove(page: Page, groupKey: string, targetGroupKey: string) {
  const source = await center(page.getByTestId(`sidebar-project-group-toggle-${groupKey}`));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y + 7);
  // A group drag offers no row zones: the "New group" zone must stay away.
  await expect(page.getByTestId("sidebar-project-drop-new-group")).toHaveCount(0);
  const target = await page.getByTestId(`sidebar-project-group-${targetGroupKey}`).boundingBox();
  if (!target) throw new Error("Expected a visible target group");
  await page.mouse.move(target.x + target.width / 2, target.y - 2, { steps: 8 });
  await attachSidebarScreenshot(page, "group-drag-active");
  await page.mouse.up();
}

async function attachSidebarScreenshot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.getByTestId("sidebar-project-workspace-list-scroll").screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test.describe("Project groups by drag and drop", () => {
  test.describe.configure({ timeout: 180_000 });

  test("drags projects into, out of, and into new groups, and creates one from the display menu", async ({
    page,
  }) => {
    const a = await seedWorkspace({ repoPrefix: "group-drag-a-" });
    const b = await seedWorkspace({ repoPrefix: "group-drag-b-" });
    const c = await seedWorkspace({ repoPrefix: "group-drag-c-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expectProjectUngrouped(page, a.projectKey);
      await expectProjectUngrouped(page, b.projectKey);
      await expectProjectUngrouped(page, c.projectKey);

      await test.step("the project menu's New group opens the modal with that project ticked", async () => {
        await openProjectContextMenu(page, a.projectKey);
        await page.getByTestId(`sidebar-project-menu-group-${a.projectKey}`).click();
        await page.getByTestId("project-group-picker-create").click();
        await expect(
          page.getByTestId(`project-group-create-member-${a.projectKey}`),
        ).toHaveAttribute("aria-checked", "true");
        await createGroupInModal(page, "Client X");
        await expectProjectInGroup(page, "client x", a.projectKey);
      });

      await test.step("dropping a row on a group header puts it first in that group", async () => {
        await dragProjectRowTo(
          page,
          b.projectKey,
          page.getByTestId("sidebar-project-group-header-client x"),
        );
        await expectProjectInGroup(page, "client x", b.projectKey);
        await expectGroupRowOrder(page, "client x", [b.projectKey, a.projectKey]);
      });

      await test.step("dropping a grouped row on Remove from group ungroups it", async () => {
        const source = await center(page.getByTestId(`sidebar-project-row-${a.projectKey}`));
        await page.mouse.move(source.x, source.y);
        await page.mouse.down();
        await page.mouse.move(source.x, source.y + 7);
        const zone = page.getByTestId("sidebar-project-drop-ungroup");
        await expect(zone).toBeVisible();
        await attachSidebarScreenshot(page, "drag-active-zones");
        const destination = await center(zone);
        await page.mouse.move(destination.x, destination.y, { steps: 6 });
        await page.mouse.up();
        await expectProjectUngrouped(page, a.projectKey);
        await expectProjectInGroup(page, "client x", b.projectKey);
      });

      await test.step("dropping a row on New group opens the modal with it ticked", async () => {
        await dragProjectRowTo(
          page,
          c.projectKey,
          page.getByTestId("sidebar-project-drop-new-group"),
        );
        await expect(
          page.getByTestId(`project-group-create-member-${c.projectKey}`),
        ).toHaveAttribute("aria-checked", "true");
        await expect(
          page.getByTestId(`project-group-create-member-${a.projectKey}`),
        ).toHaveAttribute("aria-checked", "false");
        await attachSidebarScreenshot(page, "create-modal-from-drop");
        await createGroupInModal(page, "Client Y");
        await expectProjectInGroup(page, "client y", c.projectKey);
      });

      await test.step("the display menu creates a group from ticked members", async () => {
        await page.getByTestId("sidebar-display-preferences-menu").click();
        await page.getByTestId("sidebar-display-new-group").click();
        await page.getByTestId(`project-group-create-member-${a.projectKey}`).click();
        await page.getByTestId(`project-group-create-member-${c.projectKey}`).click();
        await expect(page.getByTestId("project-group-create-confirm")).toBeDisabled();
        await createGroupInModal(page, "Client Z");
        await expectProjectInGroup(page, "client z", a.projectKey);
        await expectProjectInGroup(page, "client z", c.projectKey);
        await expect(page.getByTestId("sidebar-project-group-client y")).toHaveCount(0);
        await expectProjectInGroup(page, "client x", b.projectKey);
      });

      await test.step("dragging a group header above another group reorders the groups", async () => {
        await expectGroupOrder(page, ["client x", "client z"]);
        await dragGroupHeaderAbove(page, "client z", "client x");
        await expectGroupOrder(page, ["client z", "client x"]);
      });

      await test.step("the group order survives a reload", async () => {
        await page.reload();
        await waitForSidebarHydration(page);
        await expectGroupOrder(page, ["client z", "client x"]);
      });

      await test.step("the header menu moves a group down and still opens after a drag", async () => {
        await page.getByTestId("sidebar-project-group-header-client z").hover();
        await page.getByTestId("sidebar-project-group-kebab-client z").click();
        await expect(
          page.getByTestId("sidebar-project-group-menu-move-up-client z"),
        ).toBeDisabled();
        await page.getByTestId("sidebar-project-group-menu-move-down-client z").click();
        await expectGroupOrder(page, ["client x", "client z"]);
      });

      await test.step("clicking a header still collapses the group", async () => {
        await page.getByTestId("sidebar-project-group-toggle-client x").click();
        await expect(page.getByTestId("sidebar-project-group-count-client x")).toHaveText("1");
      });
    } finally {
      await c.cleanup();
      await b.cleanup();
      await a.cleanup();
    }
  });
});
