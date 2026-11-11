import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function workspaceRenameModalTestId(workspaceId: string, suffix: string): string {
  return `sidebar-workspace-rename-modal-${getServerId()}:${workspaceId}-${suffix}`;
}

function workspaceRenameInputTestId(workspaceId: string): string {
  return `sidebar-workspace-rename-input-${getServerId()}:${workspaceId}`;
}

async function chooseRenameFromKebab(page: Page, workspaceId: string): Promise<void> {
  const serverId = getServerId();
  const row = page.getByTestId(workspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const renameItem = page.getByTestId(`sidebar-workspace-menu-rename-${serverId}:${workspaceId}`);
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();
}

/** Lets the app render a server message the gate just forwarded. */
async function waitForTwoFrames(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    await nextFrame();
    await nextFrame();
  });
}

type DaemonWebSocketGate = Awaited<ReturnType<typeof installDaemonWebSocketGate>>;

/** Sets the title from a second daemon client and waits until this page has rendered it. */
async function renameFromAnotherClient(
  page: Page,
  gate: DaemonWebSocketGate,
  workspace: Awaited<ReturnType<typeof seedWorkspace>>,
  title: string,
): Promise<void> {
  gate.holdNextServerMessage("workspace_update");
  await workspace.client.setWorkspaceTitle(workspace.workspaceId, title);
  await gate.waitForHeldServerMessage("workspace_update");
  gate.releaseHeldServerMessage("workspace_update");
  await waitForTwoFrames(page);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function rowBox(page: Page, workspaceId: string): Promise<Box> {
  const box = await page.getByTestId(workspaceRowTestId(workspaceId)).boundingBox();
  if (!box) throw new Error(`sidebar row ${workspaceId} has no layout box`);
  return box;
}

// In Model B the workspace title is its identity: renaming sets a custom title
// layered over the derived branch/directory name, and reconciliation never
// touches it. The sidebar row shows the title verbatim — no branch mutation.
test.describe("Sidebar workspace rename", () => {
  test("renaming in place sets a custom title without moving the row, and survives reload", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-" });

    try {
      expect(workspace.workspaceName).toBe("main");

      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });
      const restingBox = await rowBox(page, workspace.workspaceId);

      await chooseRenameFromKebab(page, workspace.workspaceId);
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));
      await expect(input).toBeFocused();
      await expect(input).toBeEditable();
      await expect(input).toHaveValue("main");
      await expect(
        page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "input")),
      ).toHaveCount(0);
      expect(await rowBox(page, workspace.workspaceId)).toEqual(restingBox);

      const customTitle = "Payments Refactor";
      // The whole title is selected, so typing replaces it.
      await page.keyboard.type(customTitle);
      expect(await rowBox(page, workspace.workspaceId)).toEqual(restingBox);
      await page.keyboard.press("Enter");

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      // The title is shown exactly as typed — not slugified into a branch name.
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toContainText(
        customTitle,
      );
      expect(await rowBox(page, workspace.workspaceId)).toEqual(restingBox);

      // The custom title is backing metadata on the workspace: a full reload
      // re-resolves the descriptor from persistence and must not lose it. This
      // exercises the same descriptor resolution reconciliation re-runs against,
      // so a reconcile pass cannot overwrite the user's title either.
      await page.reload();
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toContainText(
        customTitle,
        { timeout: 30_000 },
      );
    } finally {
      await workspace.cleanup();
    }
  });

  test("Escape discards an in-place rename and clicking away saves it", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-blur-" });

    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      await page.keyboard.type("Discarded title");
      await page.keyboard.press("Escape");
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("main");
      await expect(row).not.toContainText("Discarded title");

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      // Clicking inside the field places the caret; it does not press the row underneath.
      await input.click();
      await expect(input).toBeFocused();
      await input.fill("Saved on blur");
      // Click empty space in the main pane, away from any control.
      await page.mouse.click(900, 700);
      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(row).toContainText("Saved on blur");
    } finally {
      await workspace.cleanup();
    }
  });

  test("the submitted title stays on screen until the renamed workspace arrives", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-hold-" });

    try {
      const gate = await installDaemonWebSocketGate(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      await page.keyboard.type("Held title");
      // The daemon answers the rename before it pushes the renamed workspace.
      gate.holdNextServerMessage("workspace_update");
      await page.keyboard.press("Enter");
      await gate.waitForHeldServerMessage("workspace_update");

      await expect(input).toHaveValue("Held title");
      await expect(input).not.toBeEditable();
      await expect(row).not.toContainText("main");

      gate.releaseHeldServerMessage("workspace_update");
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("Held title");
    } finally {
      await workspace.cleanup();
    }
  });

  test("an untouched in-place rename keeps a title set elsewhere while it was open", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-external-" });

    try {
      const gate = await installDaemonWebSocketGate(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("main");

      await renameFromAnotherClient(page, gate, workspace, "External title");

      await page.mouse.click(900, 700);
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("External title");
      expect(gate.getClientRequestCount("workspace.title.set.request")).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("saving after a rename elsewhere holds the submitted title until it arrives", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-external-save-" });

    try {
      const gate = await installDaemonWebSocketGate(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      await renameFromAnotherClient(page, gate, workspace, "External title");

      await input.fill("Submitted title");
      gate.holdNextServerMessage("workspace_update");
      await page.keyboard.press("Enter");
      await gate.waitForHeldServerMessage("workspace_update");

      await expect(input).toHaveValue("Submitted title");
      await expect(row).not.toContainText("External title");

      gate.releaseHeldServerMessage("workspace_update");
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("Submitted title");
    } finally {
      await workspace.cleanup();
    }
  });

  test("submitting the title another client just set closes the field", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-external-same-" });

    try {
      const gate = await installDaemonWebSocketGate(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      await renameFromAnotherClient(page, gate, workspace, "External title");

      // The daemon accepts it, but the title does not change, so no renamed workspace follows.
      await input.fill("External title");
      await page.keyboard.press("Enter");
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("External title");

      // The row is a row again: its menu opens and renames.
      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
    } finally {
      await workspace.cleanup();
    }
  });

  test("a rename elsewhere delivered while saving does not close the field", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-external-pending-" });

    try {
      const gate = await installDaemonWebSocketGate(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      await input.fill("Submitted title");

      // Another client's rename lands just before ours. The page receives, in daemon order: that
      // rename, our response, our renamed workspace. Each is held until the previous is rendered.
      gate.holdNextServerMessage("workspace_update");
      await workspace.client.setWorkspaceTitle(workspace.workspaceId, "External title");
      await gate.waitForHeldServerMessage("workspace_update");
      gate.holdNextServerMessage("workspace.title.set.response");
      gate.holdNextServerMessage("workspace_update");
      await page.keyboard.press("Enter");
      await gate.waitForHeldServerMessage("workspace.title.set.response");

      // Releases the oldest held update: the other client's. Ours stays held behind it.
      gate.releaseHeldServerMessage("workspace_update");
      await gate.waitForHeldServerMessage("workspace_update");
      await waitForTwoFrames(page);
      await expect(input).toHaveValue("Submitted title");

      gate.releaseHeldServerMessage("workspace.title.set.response");
      await waitForTwoFrames(page);
      await expect(input).toHaveValue("Submitted title");
      await expect(row).not.toContainText("External title");

      gate.releaseHeldServerMessage("workspace_update");
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("Submitted title");
    } finally {
      await workspace.cleanup();
    }
  });

  test("a later rename that replaces the saved title closes the field", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-superseded-" });

    try {
      const gate = await installDaemonWebSocketGate(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId));

      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
      await input.fill("Submitted title");

      // The daemon builds each update from its latest record, so a rename that lands after ours
      // is accepted can be published in its place. Our update stays held: the page never sees it.
      gate.holdNextServerMessage("workspace.title.set.response");
      gate.holdNextServerMessage("workspace_update");
      await page.keyboard.press("Enter");
      await gate.waitForHeldServerMessage("workspace.title.set.response");
      await gate.waitForHeldServerMessage("workspace_update");
      gate.releaseHeldServerMessage("workspace.title.set.response");
      await waitForTwoFrames(page);
      await expect(input).toHaveValue("Submitted title");

      await workspace.client.setWorkspaceTitle(workspace.workspaceId, "Later title");
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("Later title");
      await chooseRenameFromKebab(page, workspace.workspaceId);
      await expect(input).toBeFocused();
    } finally {
      await workspace.cleanup();
    }
  });

  test("below the lg breakpoint renaming opens the modal", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-modal-" });

    try {
      await page.setViewportSize({ width: 800, height: 800 });
      await gotoAppShell(page);
      await chooseRenameFromKebab(page, workspace.workspaceId);

      const input = page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "input"));
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId(workspaceRenameInputTestId(workspace.workspaceId))).toHaveCount(
        0,
      );
      await input.fill("Modal Title");
      await page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "submit")).click();
      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toContainText(
        "Modal Title",
      );
    } finally {
      await workspace.cleanup();
    }
  });
});

async function toggleBackgroundWorkspaces(page: Page): Promise<void> {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Show background", exact: true }).click();
  await page.keyboard.press("Escape");
}

async function expectWorkspaceInSidebar(page: Page, workspaceId: string): Promise<void> {
  // Rows have no single accessible role: their nested title and actions share this container.
  await expect(page.getByTestId(workspaceRowTestId(workspaceId))).toBeVisible({ timeout: 30_000 });
}

async function expectWorkspaceHidden(page: Page, workspaceId: string): Promise<void> {
  await expect(page.getByTestId(workspaceRowTestId(workspaceId))).toHaveCount(0);
}

async function reconnectApp(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByLabel("Display preferences", { exact: true })).toBeVisible();
}

async function expectWorkerOpen(page: Page): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable({
    timeout: 30_000,
  });
  await expect(page.getByText("Background reviewer", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Background review prompt", { exact: true }).first()).toBeVisible();
}

test("background workspace stays directly accessible across sidebar toggles and reconnect", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-background-",
    title: "Background review",
    background: true,
  });
  try {
    const worker = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Background reviewer",
      initialPrompt: "Background review prompt",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    await test.step("Default sidebar hides background work", async () => {
      await gotoAppShell(page);
      await expectWorkspaceHidden(page, workspace.workspaceId);
    });
    await test.step("Show background exposes the fully replicated workspace", async () => {
      await toggleBackgroundWorkspaces(page);
      await expectWorkspaceInSidebar(page, workspace.workspaceId);
      await reconnectApp(page);
      await expectWorkspaceInSidebar(page, workspace.workspaceId);
    });
    await test.step("Direct agent navigation survives hiding and reconnect", async () => {
      await toggleBackgroundWorkspaces(page);
      await expectWorkspaceHidden(page, workspace.workspaceId);
      await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: worker.id });
      await expectWorkerOpen(page);
      await expectWorkspaceHidden(page, workspace.workspaceId);
      await reconnectApp(page);
      await expectWorkerOpen(page);
      await expectWorkspaceHidden(page, workspace.workspaceId);
      await page.screenshot({ path: testInfo.outputPath("background-direct-open.png") });
    });
  } finally {
    await workspace.cleanup();
  }
});
