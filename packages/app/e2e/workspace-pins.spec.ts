import { test, expect } from "./fixtures";
import { gotoWorkspace } from "./helpers/launcher";
import { gotoAppShell } from "./helpers/app";
import { getServerId } from "./helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { togglePinFromMenu, tabRowPin, sidebarPin } from "./helpers/pins";
import { expectTerminalTabOpen } from "./helpers/workspace-tabs";
import type { PinnedTabTarget } from "../src/workspace-pins/target";

const TERMINAL_TARGET: PinnedTabTarget = { kind: "terminal" };

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({ repoPrefix: "workspace-pins-e2e-" });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test.describe("Pinned tab targets", () => {
  test("pinning a target from the dropdown adds its quick-launch button to the tab row, unpinning removes it", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);

    await expect(tabRowPin(page, TERMINAL_TARGET)).toHaveCount(0);

    await togglePinFromMenu(page, TERMINAL_TARGET);
    await expect(tabRowPin(page, TERMINAL_TARGET)).toBeVisible({ timeout: 10_000 });

    await togglePinFromMenu(page, TERMINAL_TARGET);
    await expect(tabRowPin(page, TERMINAL_TARGET)).toHaveCount(0, { timeout: 10_000 });
  });

  test("clicking the pinned quick-launch button in the tab row opens a terminal tab", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await gotoWorkspace(page, workspace.workspaceId);

    await togglePinFromMenu(page, TERMINAL_TARGET);
    await tabRowPin(page, TERMINAL_TARGET).click();

    await expectTerminalTabOpen(page);
  });

  test("the pinned button is mirrored in the sidebar workspace row and launches a terminal in that workspace", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await gotoWorkspace(page, workspace.workspaceId);
    await togglePinFromMenu(page, TERMINAL_TARGET);

    await gotoAppShell(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();

    await expect(sidebarPin(page, TERMINAL_TARGET)).toBeVisible({ timeout: 10_000 });
    await sidebarPin(page, TERMINAL_TARGET).click();

    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    await expectTerminalTabOpen(page);
  });
});
