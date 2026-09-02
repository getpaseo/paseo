import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openProjectContextMenu } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const GROUP_NAME = "Client X";
const GROUP_KEY = "client x";
const RENAMED_GROUP_NAME = "Client Y";
const RENAMED_GROUP_KEY = "client y";

async function openGroupPicker(page: Page, projectViewKey: string) {
  await openProjectContextMenu(page, projectViewKey);
  await page.getByTestId(`sidebar-project-menu-group-${projectViewKey}`).click();
  await expect(page.getByTestId("project-group-picker-create")).toBeVisible();
}

/** Visual evidence for the QA report, kept with the run's artifacts whatever the outcome. */
async function attachSidebarScreenshot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.getByTestId("sidebar-project-workspace-list-scroll").screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

// Scoped to the section wrappers rather than the lists: a non-scrolling web DraggableList does
// not put its testID in the DOM, and the wrappers are what say which section a row is in.
async function expectProjectInGroup(page: Page, groupKey: string, projectViewKey: string) {
  const section = page.getByTestId(`sidebar-project-group-${groupKey}`);
  await expect(section.getByTestId(`sidebar-project-row-${projectViewKey}`)).toBeVisible();
}

async function expectProjectUngrouped(page: Page, projectViewKey: string) {
  const list = page.getByTestId("sidebar-ungrouped-project-list");
  await expect(list.getByTestId(`sidebar-project-row-${projectViewKey}`)).toBeVisible();
}

test.describe("Project groups", () => {
  test.describe.configure({ timeout: 180_000 });

  test("creates, joins, collapses, renames, and leaves a group against the daemon", async ({
    page,
  }) => {
    const first = await seedWorkspace({ repoPrefix: "project-groups-first-" });
    const second = await seedWorkspace({ repoPrefix: "project-groups-second-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expectProjectUngrouped(page, first.projectKey);
      await expectProjectUngrouped(page, second.projectKey);

      await test.step("naming a new group from one project creates the header", async () => {
        await openGroupPicker(page, first.projectKey);
        await page.getByTestId("project-group-picker-create").click();
        await expect(page.getByTestId("project-group-create-input")).toBeVisible();
        await page.getByTestId("project-group-create-input").fill(GROUP_NAME);
        await page.getByTestId("project-group-create-confirm").click();

        await expect(
          page.getByTestId(`sidebar-project-context-menu-${first.projectKey}`),
        ).toHaveCount(0);
        await expect(page.getByTestId(`sidebar-project-group-header-${GROUP_KEY}`)).toContainText(
          GROUP_NAME,
        );
        await expectProjectInGroup(page, GROUP_KEY, first.projectKey);
        await expectProjectUngrouped(page, second.projectKey);
      });

      await test.step("picking the existing group moves the second project under it", async () => {
        await openGroupPicker(page, second.projectKey);
        await expect(page.getByTestId(`project-group-picker-row-${GROUP_KEY}`)).toHaveAttribute(
          "aria-checked",
          "false",
        );
        await page.getByTestId(`project-group-picker-row-${GROUP_KEY}`).click();
        await expectProjectInGroup(page, GROUP_KEY, second.projectKey);
        await expect(page.getByTestId("sidebar-ungrouped-project-list")).toHaveCount(0);
        await attachSidebarScreenshot(page, "group-expanded");
      });

      await test.step("the group survives a reload because the daemon stores it", async () => {
        await page.reload();
        await waitForSidebarHydration(page);
        await expectProjectInGroup(page, GROUP_KEY, first.projectKey);
        await expectProjectInGroup(page, GROUP_KEY, second.projectKey);
      });

      await test.step("collapsing the header hides its projects and shows how many", async () => {
        const toggle = page.getByTestId(`sidebar-project-group-toggle-${GROUP_KEY}`);
        const count = page.getByTestId(`sidebar-project-group-count-${GROUP_KEY}`);
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(count).toHaveCount(0);

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(count).toHaveText("2");
        await expect(page.getByTestId(`sidebar-project-row-${first.projectKey}`)).toHaveCount(0);
        await expect(page.getByTestId(`sidebar-project-row-${second.projectKey}`)).toHaveCount(0);
        await attachSidebarScreenshot(page, "group-collapsed");

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(count).toHaveCount(0);
        await expectProjectInGroup(page, GROUP_KEY, first.projectKey);
      });

      await test.step("renaming the group renames it for every member", async () => {
        await page.getByTestId(`sidebar-project-group-header-${GROUP_KEY}`).hover();
        await page.getByTestId(`sidebar-project-group-kebab-${GROUP_KEY}`).click();
        await page.getByTestId(`sidebar-project-group-menu-rename-${GROUP_KEY}`).click();
        await page.getByTestId("project-group-rename-input").fill(RENAMED_GROUP_NAME);
        await page.getByTestId("project-group-rename-confirm").click();

        await expect(
          page.getByTestId(`sidebar-project-group-header-${RENAMED_GROUP_KEY}`),
        ).toContainText(RENAMED_GROUP_NAME);
        await expect(page.getByTestId(`sidebar-project-group-${GROUP_KEY}`)).toHaveCount(0);
        await expectProjectInGroup(page, RENAMED_GROUP_KEY, first.projectKey);
        await expectProjectInGroup(page, RENAMED_GROUP_KEY, second.projectKey);
      });

      await test.step("choosing No group returns a project to the ungrouped list", async () => {
        await openGroupPicker(page, first.projectKey);
        await expect(
          page.getByTestId(`project-group-picker-row-${RENAMED_GROUP_KEY}`),
        ).toHaveAttribute("aria-checked", "true");
        await page.getByTestId("project-group-picker-none").click();
        await expectProjectUngrouped(page, first.projectKey);
        await expectProjectInGroup(page, RENAMED_GROUP_KEY, second.projectKey);
      });

      await test.step("ungrouping from the header removes the last member and the header", async () => {
        await page.getByTestId(`sidebar-project-group-header-${RENAMED_GROUP_KEY}`).hover();
        await page.getByTestId(`sidebar-project-group-kebab-${RENAMED_GROUP_KEY}`).click();
        await page.getByTestId(`sidebar-project-group-menu-ungroup-${RENAMED_GROUP_KEY}`).click();
        await expect(page.getByTestId(`sidebar-project-group-${RENAMED_GROUP_KEY}`)).toHaveCount(0);
        await expectProjectUngrouped(page, first.projectKey);
        await expectProjectUngrouped(page, second.projectKey);
      });
    } finally {
      await second.cleanup();
      await first.cleanup();
    }
  });
});

test.describe("Project groups on a compact screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the picker opens as a sheet page from the project kebab", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "project-groups-compact-" });
    try {
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Open menu" }).tap();
      const row = page.getByTestId(`sidebar-project-row-${seeded.projectKey}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await page.getByTestId(`sidebar-project-kebab-${seeded.projectKey}`).tap();
      await page.getByTestId(`sidebar-project-menu-group-${seeded.projectKey}`).tap();

      await expect(page.getByTestId("project-group-picker-create")).toBeVisible();
      await expect(page.getByTestId("project-group-picker-none")).toBeVisible();
      await expect(
        page.getByTestId(`sidebar-project-menu-open-settings-${seeded.projectKey}`),
      ).toHaveCount(0);
    } finally {
      await seeded.cleanup();
    }
  });
});
