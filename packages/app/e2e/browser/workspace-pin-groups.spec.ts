import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { addConnectedHostAndReload, waitForConnectedHost } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openMobileAgentSidebar, pinWorkspaceFromSidebar } from "../support/helpers/sidebar";

const DEFAULT_GROUP_NAME = "Pinned";
const SECOND_GROUP_NAME = "Deep work";
const RENAMED_GROUP_NAME = "Focus";
const ALPHA_WORKSPACE_NAME = "Alpha pinned workspace";
const BETA_WORKSPACE_NAME = "Beta pinned workspace";
const GROUP_NOT_FOUND_ERROR = "Pin group not found";
const DELETE_REJECTED_ERROR = "Pin group delete rejected";

function workspaceRowTestId(workspaceId: string, serverId = getServerId()): string {
  return `sidebar-workspace-row-${serverId}:${workspaceId}`;
}

function workspaceRow(page: Page, workspaceId: string, serverId = getServerId()) {
  return page.getByTestId(workspaceRowTestId(workspaceId, serverId));
}

function pinnedSection(page: Page) {
  return page.getByTestId("sidebar-pinned-section");
}

function bottomSheetBackdrop(page: Page) {
  return page.getByRole("button", { name: "Bottom sheet backdrop" }).first();
}

async function openPinGroupsMenu(page: Page): Promise<void> {
  await page.getByTestId("sidebar-pin-groups-menu-trigger").click();
  await expect(
    page.getByTestId("sidebar-pin-groups-menu").or(bottomSheetBackdrop(page)),
  ).toBeVisible({ timeout: 10_000 });
}

async function expectPinGroupsMenuClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);
  await expect(bottomSheetBackdrop(page)).not.toBeVisible({ timeout: 10_000 });
}

async function closePinGroupsMenu(page: Page): Promise<void> {
  const backdrop = bottomSheetBackdrop(page);
  if (await backdrop.isVisible()) {
    await backdrop.click({ position: { x: 12, y: 12 } });
  } else {
    await page.keyboard.press("Escape");
  }
  await expectPinGroupsMenuClosed(page);
}

async function createPinGroup(page: Page, name: string): Promise<void> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-group-create").click();

  const input = page.getByTestId("sidebar-pin-group-create-input");
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByTestId("sidebar-pin-group-create-submit").click();

  await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(name, {
    timeout: 10_000,
  });
  await expect(input).toHaveCount(0);
  await closePinGroupsMenu(page);
}

function pinGroupChoice(page: Page, name: string) {
  return page.locator('[data-testid^="sidebar-pin-group-choice-"]').filter({ hasText: name });
}

async function switchPinGroup(page: Page, name: string): Promise<string> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-groups-switch").click();

  const choice = pinGroupChoice(page, name);
  await expect(choice).toHaveCount(1, { timeout: 10_000 });

  const testId = await choice.getAttribute("data-testid");
  if (!testId) throw new Error(`Pin group choice for ${name} has no data-testid`);
  await choice.click();
  await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(name);
  await expectPinGroupsMenuClosed(page);
  return testId.replace("sidebar-pin-group-choice-", "");
}

async function openPinGroupSwitcher(page: Page): Promise<void> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-groups-switch").click();
  await expect(pinGroupChoice(page, DEFAULT_GROUP_NAME)).toBeVisible({ timeout: 10_000 });
}

async function renameActivePinGroupWithRetry(page: Page, name: string): Promise<void> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-group-rename").click();

  const input = page.getByTestId("sidebar-pin-group-rename-input");
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByTestId("sidebar-pin-group-rename-submit").click();

  await expect(page.getByTestId("sidebar-pin-group-form-error")).toContainText(
    GROUP_NOT_FOUND_ERROR,
    { timeout: 10_000 },
  );
  await expect(input).toBeVisible();
  await expect(input).toBeEditable();

  await page.getByTestId("sidebar-pin-group-rename-submit").click();
  await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(name, {
    timeout: 10_000,
  });
  await expect(input).toHaveCount(0);
  await closePinGroupsMenu(page);
}

async function deleteActivePinGroup(page: Page, name: string): Promise<void> {
  await openPinGroupsMenu(page);
  const confirmationMessage = acceptNextDialog(page);

  await page.getByTestId("sidebar-pin-group-delete").click();
  await expect(confirmationMessage).resolves.toContain(name);
}

function acceptNextDialog(page: Page): Promise<string> {
  return new Promise<string>((resolve) =>
    page.once("dialog", (dialog) => {
      resolve(dialog.message());
      void dialog.accept();
    }),
  );
}

async function hideExpoFastRefreshOverlay(page: Page): Promise<void> {
  // Expo injects this fixed black lightning badge while Metro applies a fast refresh. Its timing
  // is unrelated to the product UI, so keep it out of deterministic QA captures.
  await page.addStyleTag({
    content: ".__expo_fast_refresh { display: none !important; }",
  });
}

interface PinGroupMutationGate {
  renameAttemptCount(): number;
  deleteAttemptCount(): number;
}

function readSessionMessage(
  message: string | Buffer,
): { type?: unknown; requestId?: unknown } | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    if (envelope.type !== "session" || typeof envelope.message !== "object") return null;
    return envelope.message as { type?: unknown; requestId?: unknown };
  } catch {
    return null;
  }
}

async function installPinGroupMutationGate(
  page: Page,
  input: { rejectFirstRename?: boolean; rejectFirstDelete?: boolean },
): Promise<PinGroupMutationGate> {
  let renameAttempts = 0;
  let deleteAttempts = 0;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = readSessionMessage(message);
      if (
        request?.type === "workspace.pin_group.rename.request" &&
        typeof request.requestId === "string"
      ) {
        renameAttempts += 1;
        if (input.rejectFirstRename && renameAttempts === 1) {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId: request.requestId,
                  requestType: "workspace.pin_group.rename.request",
                  error: GROUP_NOT_FOUND_ERROR,
                  code: "group_not_found",
                },
              },
            }),
          );
          return;
        }
      }
      if (
        request?.type === "workspace.pin_group.delete.request" &&
        typeof request.requestId === "string"
      ) {
        deleteAttempts += 1;
        if (input.rejectFirstDelete && deleteAttempts === 1) {
          setTimeout(() => {
            try {
              ws.send(
                JSON.stringify({
                  type: "session",
                  message: {
                    type: "rpc_error",
                    payload: {
                      requestId: request.requestId,
                      requestType: "workspace.pin_group.delete.request",
                      error: DELETE_REJECTED_ERROR,
                      code: "internal_error",
                    },
                  },
                }),
              );
            } catch {
              // client socket already closed
            }
          }, 500);
          return;
        }
      }

      try {
        server.send(message);
      } catch {
        // server socket already closed
      }
    });

    server.onMessage((message) => {
      try {
        ws.send(message);
      } catch {
        // client socket already closed
      }
    });
  });

  return {
    renameAttemptCount: () => renameAttempts,
    deleteAttemptCount: () => deleteAttempts,
  };
}

async function expectOnlyWorkspacePinned(
  page: Page,
  visible: SeededWorkspace,
  hidden: SeededWorkspace,
  visibleServerId = getServerId(),
  hiddenServerId = getServerId(),
): Promise<void> {
  const section = pinnedSection(page);
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(
    section.getByTestId(workspaceRowTestId(visible.workspaceId, visibleServerId)),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    section.getByTestId(workspaceRowTestId(hidden.workspaceId, hiddenServerId)),
  ).toHaveCount(0);
}

async function pinWorkspaceFromServerSidebar(
  page: Page,
  workspaceId: string,
  serverId: string,
): Promise<void> {
  const key = `${serverId}:${workspaceId}`;
  const row = page.getByTestId(`sidebar-workspace-row-${key}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${key}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const pinItem = page.getByTestId(`sidebar-workspace-menu-pin-${key}`);
  await expect(pinItem).toBeVisible({ timeout: 10_000 });
  await pinItem.click();
  await expect(bottomSheetBackdrop(page)).not.toBeVisible({ timeout: 10_000 });
}

async function fetchWorkspaceDescriptor(workspace: SeededWorkspace) {
  const descriptor = (await workspace.client.fetchWorkspaces()).entries.find(
    (entry) => entry.id === workspace.workspaceId,
  );
  if (!descriptor) throw new Error(`Workspace ${workspace.workspaceId} is missing from daemon`);
  return descriptor;
}

async function fetchPinGroupId(workspace: SeededWorkspace): Promise<string | null> {
  const descriptor = await fetchWorkspaceDescriptor(workspace);
  return descriptor.pinGroupId ?? null;
}

async function expectPinGroupId(
  workspace: SeededWorkspace,
  expected: string | null,
): Promise<void> {
  await expect.poll(() => fetchPinGroupId(workspace), { timeout: 10_000 }).toBe(expected);
}

test.describe("Workspace pin groups", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps each group's membership and active selection across reload", async ({
    page,
  }, testInfo) => {
    const alpha = await seedWorkspace({
      repoPrefix: "pin-groups-alpha-",
      title: ALPHA_WORKSPACE_NAME,
    });
    const beta = await seedWorkspace({
      repoPrefix: "pin-groups-beta-",
      title: BETA_WORKSPACE_NAME,
    });

    try {
      await gotoAppShell(page);
      await expect(workspaceRow(page, alpha.workspaceId)).toContainText(ALPHA_WORKSPACE_NAME, {
        timeout: 30_000,
      });
      await expect(workspaceRow(page, beta.workspaceId)).toContainText(BETA_WORKSPACE_NAME, {
        timeout: 30_000,
      });

      await pinWorkspaceFromSidebar(page, alpha.workspaceId);
      await expectOnlyWorkspacePinned(page, alpha, beta);

      await createPinGroup(page, RENAMED_GROUP_NAME);
      const secondGroupId = await switchPinGroup(page, RENAMED_GROUP_NAME);
      expect(secondGroupId).not.toBe("default");

      await pinWorkspaceFromSidebar(page, beta.workspaceId);
      await expectOnlyWorkspacePinned(page, beta, alpha);

      const defaultGroupId = await switchPinGroup(page, DEFAULT_GROUP_NAME);
      expect(defaultGroupId).toBe("default");
      await expectOnlyWorkspacePinned(page, alpha, beta);
      await hideExpoFastRefreshOverlay(page);
      await page.screenshot({
        path: testInfo.outputPath("default-pin-group.png"),
        fullPage: true,
      });

      await switchPinGroup(page, RENAMED_GROUP_NAME);
      await expectOnlyWorkspacePinned(page, beta, alpha);

      await page.reload();

      await expectOnlyWorkspacePinned(page, beta, alpha);
      await expect(fetchPinGroupId(alpha)).resolves.toBe(defaultGroupId);
      await expect(fetchPinGroupId(beta)).resolves.toBe(secondGroupId);
      await hideExpoFastRefreshOverlay(page);
      await page.screenshot({
        path: testInfo.outputPath("active-pin-group-after-reload.png"),
        fullPage: true,
      });

      await openPinGroupSwitcher(page);
      await expect(pinGroupChoice(page, DEFAULT_GROUP_NAME)).toHaveCount(1);
      await expect(pinGroupChoice(page, RENAMED_GROUP_NAME)).toHaveCount(1);
      await hideExpoFastRefreshOverlay(page);
      await page.screenshot({
        path: testInfo.outputPath("pin-group-switcher-menu-open.png"),
        fullPage: true,
      });
      await pinGroupChoice(page, RENAMED_GROUP_NAME).click();
      await expectPinGroupsMenuClosed(page);
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("keeps a failed rename visible and allows a successful retry", async ({ page }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "pin-groups-rename-retry-",
      title: "Rename retry workspace",
    });

    try {
      const mutationGate = await installPinGroupMutationGate(page, { rejectFirstRename: true });
      await gotoAppShell(page);
      await expect(workspaceRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });

      await createPinGroup(page, SECOND_GROUP_NAME);
      await switchPinGroup(page, SECOND_GROUP_NAME);
      await renameActivePinGroupWithRetry(page, "Retry renamed");

      expect(mutationGate.renameAttemptCount()).toBe(2);
      await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(
        "Retry renamed",
      );
    } finally {
      await workspace.cleanup();
    }
  });

  test("deletes a group without archiving its workspace", async ({ page }) => {
    const alpha = await seedWorkspace({
      repoPrefix: "pin-groups-delete-alpha-",
      title: ALPHA_WORKSPACE_NAME,
    });
    const beta = await seedWorkspace({
      repoPrefix: "pin-groups-delete-beta-",
      title: BETA_WORKSPACE_NAME,
    });

    try {
      await gotoAppShell(page);
      await expect(workspaceRow(page, alpha.workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, beta.workspaceId)).toBeVisible({ timeout: 30_000 });

      await pinWorkspaceFromSidebar(page, alpha.workspaceId);
      await createPinGroup(page, "Delete group");
      await switchPinGroup(page, "Delete group");
      await pinWorkspaceFromSidebar(page, beta.workspaceId);
      await expectOnlyWorkspacePinned(page, beta, alpha);

      await deleteActivePinGroup(page, "Delete group");
      await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(
        DEFAULT_GROUP_NAME,
        { timeout: 10_000 },
      );
      await expectOnlyWorkspacePinned(page, alpha, beta);
      await expect(workspaceRow(page, beta.workspaceId)).toBeVisible({ timeout: 10_000 });
      const unpinnedWorkspace = await fetchWorkspaceDescriptor(beta);
      expect(unpinnedWorkspace.pinGroupId ?? null).toBeNull();
      expect(unpinnedWorkspace.archivedAt ?? null).toBeNull();
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("renames a group through the compact bottom sheet", async ({ page }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "pin-groups-compact-rename-",
      title: "Compact rename workspace",
    });

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await gotoAppShell(page);
      await openMobileAgentSidebar(page);
      await expect(workspaceRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });

      await createPinGroup(page, "Compact group");
      await switchPinGroup(page, "Compact group");
      await openPinGroupsMenu(page);
      await expect(bottomSheetBackdrop(page)).toBeVisible();
      await page.getByTestId("sidebar-pin-group-rename").click();

      const input = page.getByTestId("sidebar-pin-group-rename-input");
      await expect(input).toBeVisible();
      await input.fill("Compact renamed");
      await page.getByTestId("sidebar-pin-group-rename-submit").click();

      await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(
        "Compact renamed",
        { timeout: 10_000 },
      );
      await expect(input).toHaveCount(0);
      await closePinGroupsMenu(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("retries a rejected compact-sheet delete without duplicate requests", async ({ page }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "pin-groups-compact-delete-",
      title: "Compact delete workspace",
    });

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const mutationGate = await installPinGroupMutationGate(page, { rejectFirstDelete: true });
      await gotoAppShell(page);
      await openMobileAgentSidebar(page);
      await expect(workspaceRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });

      await createPinGroup(page, "Compact delete");
      const groupId = await switchPinGroup(page, "Compact delete");
      await pinWorkspaceFromServerSidebar(page, workspace.workspaceId, getServerId());
      await expectPinGroupId(workspace, groupId);

      await openPinGroupsMenu(page);
      await expect(bottomSheetBackdrop(page)).toBeVisible();
      const firstConfirmationMessage = acceptNextDialog(page);
      const deleteItem = page.getByTestId("sidebar-pin-group-delete");
      await deleteItem.click();
      await expect(firstConfirmationMessage).resolves.toContain("Compact delete");
      await expect(deleteItem).toBeDisabled();
      await deleteItem.dispatchEvent("click");

      await expect(page.getByTestId("app-toast-message")).toContainText(DELETE_REJECTED_ERROR, {
        timeout: 10_000,
      });
      expect(mutationGate.deleteAttemptCount()).toBe(1);
      await expect(deleteItem).toBeEnabled();
      await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(
        "Compact delete",
      );
      await expectPinGroupId(workspace, groupId);

      const retryConfirmationMessage = acceptNextDialog(page);
      await deleteItem.click();
      await expect(retryConfirmationMessage).resolves.toContain("Compact delete");

      await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(
        DEFAULT_GROUP_NAME,
        { timeout: 10_000 },
      );
      expect(mutationGate.deleteAttemptCount()).toBe(2);
      await expectPinGroupId(workspace, null);
      const descriptor = await fetchWorkspaceDescriptor(workspace);
      expect(descriptor.pinGroupId ?? null).toBeNull();
      expect(descriptor.archivedAt ?? null).toBeNull();
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps custom groups isolated to their daemon", async ({ page }) => {
    const primary = await seedWorkspace({
      repoPrefix: "pin-groups-primary-host-",
      title: "Primary host workspace",
    });
    const secondaryDaemon = await startIsolatedHostDaemon("srv_pin_groups_secondary");
    let secondary: SeededWorkspace | null = null;

    try {
      secondary = await seedWorkspace({
        repoPrefix: "pin-groups-secondary-host-",
        title: "Secondary host workspace",
        port: secondaryDaemon.port,
      });

      await gotoAppShell(page);
      await expect(workspaceRow(page, primary.workspaceId)).toBeVisible({ timeout: 30_000 });
      await createPinGroup(page, "Primary only");
      const primaryGroupId = await switchPinGroup(page, "Primary only");
      await pinWorkspaceFromServerSidebar(page, primary.workspaceId, getServerId());
      await expectPinGroupId(primary, primaryGroupId);

      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Pin groups secondary",
        port: secondaryDaemon.port,
      });
      await waitForConnectedHost(page, {
        serverId: secondaryDaemon.serverId,
        endpoint: `localhost:${secondaryDaemon.port}`,
      });

      const secondaryRow = workspaceRow(page, secondary.workspaceId, secondaryDaemon.serverId);
      await expect(secondaryRow).toBeVisible({ timeout: 30_000 });
      await secondaryRow.click();
      await openPinGroupSwitcher(page);
      await expect(pinGroupChoice(page, "Primary only")).toHaveCount(0);
      await pinGroupChoice(page, DEFAULT_GROUP_NAME).click();
      await expectPinGroupsMenuClosed(page);

      await createPinGroup(page, "Secondary only");
      const secondaryGroupId = await switchPinGroup(page, "Secondary only");
      await pinWorkspaceFromServerSidebar(page, secondary.workspaceId, secondaryDaemon.serverId);
      await expectPinGroupId(secondary, secondaryGroupId);
      await expectOnlyWorkspacePinned(
        page,
        secondary,
        primary,
        secondaryDaemon.serverId,
        getServerId(),
      );

      const primaryRow = workspaceRow(page, primary.workspaceId);
      await expect(primaryRow).toBeVisible({ timeout: 30_000 });
      await primaryRow.click();
      await openPinGroupSwitcher(page);
      await expect(pinGroupChoice(page, "Primary only")).toHaveCount(1);
      await expect(pinGroupChoice(page, "Secondary only")).toHaveCount(0);
      await pinGroupChoice(page, "Primary only").click();
      await expectOnlyWorkspacePinned(
        page,
        primary,
        secondary,
        getServerId(),
        secondaryDaemon.serverId,
      );

      await secondaryRow.click();
      await switchPinGroup(page, "Secondary only");
      await expectOnlyWorkspacePinned(
        page,
        secondary,
        primary,
        secondaryDaemon.serverId,
        getServerId(),
      );
    } finally {
      await secondary?.cleanup();
      await secondaryDaemon.close();
      await primary.cleanup();
    }
  });
});
