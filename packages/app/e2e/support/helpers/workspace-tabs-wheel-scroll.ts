import type { Page } from "@playwright/test";
import { pressNewTabShortcut } from "./launcher";
import { panWorkspaceTabsWithWheel } from "./workspace-tabs";
import type { CreatedWorkspace } from "./with-workspace";

const OVERFLOWING_TABS_VIEWPORT = { width: 760, height: 800 };
const OVERFLOWING_TABS_COUNT = 12;

/** Open a narrow workspace with enough tabs to exercise the horizontal strip. */
export async function openOverflowingWorkspaceTabs(
  page: Page,
  workspace: CreatedWorkspace,
): Promise<void> {
  await page.setViewportSize(OVERFLOWING_TABS_VIEWPORT);
  await workspace.navigateTo();

  for (let index = 0; index < OVERFLOWING_TABS_COUNT; index += 1) {
    await pressNewTabShortcut(page);
  }
}

export { panWorkspaceTabsWithWheel };
