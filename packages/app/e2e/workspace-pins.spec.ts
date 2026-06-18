import { test, expect } from "./fixtures";
import { gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { togglePinFromMenu, tabRowPin } from "./helpers/pins";
import { expectTerminalTabOpen } from "./helpers/workspace-tabs";
import type { PinnedTabTarget } from "../src/workspace-pins/target";

const DRAFT_TARGET: PinnedTabTarget = { kind: "draft" };
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

    await expect(tabRowPin(page, DRAFT_TARGET)).toHaveCount(0);

    await togglePinFromMenu(page, DRAFT_TARGET);
    await expect(tabRowPin(page, DRAFT_TARGET)).toBeVisible({ timeout: 10_000 });

    await togglePinFromMenu(page, DRAFT_TARGET);
    await expect(tabRowPin(page, DRAFT_TARGET)).toHaveCount(0, { timeout: 10_000 });
  });

  test("clicking the pinned quick-launch button in the tab row opens a terminal tab", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await gotoWorkspace(page, workspace.workspaceId);

    await expect(tabRowPin(page, TERMINAL_TARGET)).toBeVisible({ timeout: 10_000 });
    await tabRowPin(page, TERMINAL_TARGET).click();

    await expectTerminalTabOpen(page);
  });
});
