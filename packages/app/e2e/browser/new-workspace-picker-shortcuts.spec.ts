import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The three New workspace selects each open from the keyboard: Mod+. picks the
// project, Mod+Shift+. the isolation, Mod+Alt+. the starting ref. Mod+. is also
// bound to "toggle both sidebars", so the last case proves the resolver falls
// through to the sidebar when this screen isn't the one claiming the key.
test.describe("New workspace picker shortcuts", () => {
  test.describe.configure({ timeout: 240_000 });

  // The app resolves Mod from the runtime's own platform, so the chord has to
  // follow the browser the test happens to run in.
  async function modifier(page: import("@playwright/test").Page): Promise<"Meta" | "Control"> {
    const isMac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent));
    return isMac ? "Meta" : "Control";
  }

  test("Mod+. / Mod+Shift+. / Mod+Alt+. open the three pickers", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "picker-shortcuts-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      });
      const mod = await modifier(page);

      await page.keyboard.press(`${mod}+Period`);
      const projectSearch = page.getByPlaceholder("Search projects");
      await expect(projectSearch).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");
      await expect(projectSearch).toBeHidden({ timeout: 30_000 });

      await page.keyboard.press(`${mod}+Shift+Period`);
      await expect(page.getByTestId("workspace-create-isolation-worktree")).toBeVisible({
        timeout: 30_000,
      });
      await page.keyboard.press("Escape");

      // The starting-ref row only exists under worktree isolation, which is also
      // what gates the shortcut.
      await selectWorkspaceIsolation(page, "worktree");
      await page.keyboard.press(`${mod}+Alt+Period`);
      await expect(page.getByPlaceholder("Search branches and PRs")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await seeded.cleanup();
    }
  });
});
