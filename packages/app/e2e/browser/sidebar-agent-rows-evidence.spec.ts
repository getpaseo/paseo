import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

/**
 * Capture-only. Produces the PR evidence for the sidebar agent sub-list into
 * `test-results/evidence/`, at 3x so the crops stay readable when scaled down in a PR body.
 *
 * Opt-in because it exists to write files, not to assert: the behaviour it photographs is
 * covered by `sidebar-agent-rows.spec.ts`, which runs on every push. Same shape as the
 * `PASEO_DIFF_PERF_E2E` capture spec.
 *
 *   PASEO_SIDEBAR_EVIDENCE=1 npx playwright test --project=browser \
 *     e2e/browser/sidebar-agent-rows-evidence.spec.ts
 */

const MULTI_AGENT_TITLES = [
  "Rebase onto upstream main",
  "Port sidebar agent rows",
  "Audit COMPAT tags",
];

/** The sidebar plus a little of the pane behind it, so the row's right edge is in frame. */
const SIDEBAR_CLIP = { x: 0, y: 124, width: 340, height: 292 };

/**
 * Wide enough for the sidebar plus the preference menu and its submenu, which open to the right
 * of the trigger as separate popovers. Framing them together is the point: the shot has to show
 * where the control lives, not just what it says.
 */
const MENU_CLIP = { x: 0, y: 96, width: 720, height: 480 };

/**
 * Popovers fade in, and `toBeVisible` is satisfied before the animation lands — a shot taken then
 * catches the menu half-transparent over whatever is behind it. Capture-only, so waiting a beat
 * beats plumbing an animation signal through the menu engine.
 */
async function settlePopover(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForTimeout(400);
}

test.describe("sidebar agent rows evidence", () => {
  test.skip(!process.env.PASEO_SIDEBAR_EVIDENCE, "Set PASEO_SIDEBAR_EVIDENCE=1 to capture.");
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 3 });

  test("captures the sub-list states", async ({ page }) => {
    // Two workspaces on purpose: one with several agents and one with a single agent, so every
    // shot also shows what the change does NOT do to an ordinary row.
    const busy = await seedWorkspace({ repoPrefix: "paseo-evidence-busy-" });
    const quiet = await seedWorkspace({ repoPrefix: "paseo-evidence-quiet-" });
    try {
      for (const title of MULTI_AGENT_TITLES) {
        await busy.client.createAgent({
          provider: "mock",
          cwd: busy.repoPath,
          workspaceId: busy.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }
      await quiet.client.createAgent({
        provider: "mock",
        cwd: quiet.repoPath,
        workspaceId: quiet.workspaceId,
        title: "Only agent here",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });

      await gotoAppShell(page);

      const busyRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${busy.workspaceId}`,
      );
      await expect(busyRow).toBeVisible({ timeout: 30_000 });
      const disclosure = page.getByTestId("sidebar-agent-list-disclosure");
      await expect(disclosure).toBeVisible({ timeout: 30_000 });

      // 1. Resting state. The busy workspace carries a count; the quiet one is untouched.
      await page.screenshot({
        path: "test-results/evidence/01-collapsed.png",
        clip: SIDEBAR_CLIP,
      });

      // 2. Hovered: the status indicator swaps for the expand chevron, the way a project row's
      // icon does. The count stays put on the meta line, clear of the kebab.
      await busyRow.hover();
      await expect(disclosure).toBeVisible();
      await page.screenshot({
        path: "test-results/evidence/02-hover-chevron.png",
        clip: SIDEBAR_CLIP,
      });

      // 3. Expanded: provider icon per row, dots on the meta count's left rail.
      await disclosure.click();
      const list = page.getByTestId("sidebar-agent-list");
      await expect(list).toBeVisible({ timeout: 10_000 });
      for (const title of MULTI_AGENT_TITLES) {
        await expect(list.getByText(title, { exact: true })).toBeVisible();
      }
      // Park the pointer off the sidebar and let the workspace hover card retract, or it sits
      // over the sub-list in the shot.
      await page.mouse.move(900, 620);
      await expect(page.getByTestId("workspace-hover-card")).toBeHidden({ timeout: 10_000 });
      await page.screenshot({
        path: "test-results/evidence/03-expanded.png",
        clip: SIDEBAR_CLIP,
      });
      // 4. Where the preference lives. Not the Settings screen: sidebar display preferences all
      // sit in this menu, so the new one joins Checks rather than starting a second home.
      await page.getByTestId("sidebar-display-preferences-menu").click();
      const menu = page.getByTestId("sidebar-display-preferences-content");
      await expect(menu).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("sidebar-display-show").click();
      const agentsEntry = page.getByTestId("sidebar-display-agents");
      await expect(agentsEntry).toBeVisible({ timeout: 10_000 });
      await settlePopover(page);
      await page.screenshot({ path: "test-results/evidence/04-display-menu.png", clip: MENU_CLIP });

      // 5. The three answers, with the shipped default selected.
      await agentsEntry.click();
      await expect(page.getByTestId("sidebar-agent-rows-collapsed")).toBeVisible({
        timeout: 10_000,
      });
      await settlePopover(page);
      await page.screenshot({
        path: "test-results/evidence/05-agents-options.png",
        clip: MENU_CLIP,
      });
      // 6. The same sub-list under Group by Status. Hoisted rows carry a project icon in the
      // leading slot instead of a status indicator, and that branch shipped without a toggle at
      // first — so this grouping earns a shot of its own rather than a claim that it works.
      await page.keyboard.press("Escape");
      await page.getByTestId("sidebar-display-preferences-menu").click();
      await page.getByTestId("sidebar-display-grouping").click();
      await page.getByTestId("sidebar-grouping-status").click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sidebar-status-group-done")).toBeVisible({ timeout: 20_000 });

      // Expansion is stored per workspace and survives the grouping switch, so the list is already
      // open here. Clicking the toggle again would close it.
      await expect(page.getByTestId("sidebar-agent-list-disclosure").first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId("sidebar-agent-list")).toBeVisible({ timeout: 10_000 });
      await page.mouse.move(900, 620);
      await expect(page.getByTestId("workspace-hover-card")).toBeHidden({ timeout: 10_000 });
      await settlePopover(page);
      await page.screenshot({
        path: "test-results/evidence/06-status-grouping.png",
        clip: SIDEBAR_CLIP,
      });
    } finally {
      await busy.cleanup();
      await quiet.cleanup();
    }
  });
});
