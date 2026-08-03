import { expect, type Page } from "@playwright/test";
import { getServerId } from "./server-id";

interface ContextMenuAnchor {
  x: number;
  y: number;
}

async function openContextMenuAtRowPoint(
  page: Page,
  rowTestID: string,
  menuTestID: string,
): Promise<ContextMenuAnchor> {
  const row = page.getByTestId(rowTestID);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const bounds = await row.boundingBox();
  if (!bounds) throw new Error(`Could not measure ${rowTestID}`);

  const anchor = {
    x: bounds.x + Math.min(60, bounds.width / 2),
    y: bounds.y + bounds.height / 2,
  };
  await page.mouse.click(anchor.x, anchor.y, { button: "right" });
  await expect(page.getByTestId(menuTestID)).toBeVisible({ timeout: 10_000 });
  return anchor;
}

async function expectContextMenuAtPointer(
  page: Page,
  menuTestID: string,
  anchor: ContextMenuAnchor,
): Promise<void> {
  const bounds = await page.getByTestId(menuTestID).boundingBox();
  if (!bounds) throw new Error(`Could not measure ${menuTestID}`);
  expect(Math.abs(bounds.x - anchor.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(bounds.y - (anchor.y + 4))).toBeLessThanOrEqual(2);
}

export async function openWorkspaceContextMenu(page: Page, workspaceId: string): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  const menuTestID = `sidebar-workspace-context-menu-${workspaceKey}`;
  const anchor = await openContextMenuAtRowPoint(
    page,
    `sidebar-workspace-row-${workspaceKey}`,
    menuTestID,
  );
  await expectContextMenuAtPointer(page, menuTestID, anchor);
}

export async function showWorkspaceHoverCard(page: Page, workspaceId: string): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).hover();
  await expect(page.getByTestId("workspace-hover-card")).toBeVisible();
}

export async function closeWorkspaceContextMenu(page: Page, workspaceId: string): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  await page.getByTestId(`sidebar-workspace-context-menu-${workspaceKey}-backdrop`).click();
}

export async function expectWorkspaceContextMenuOwnsAttention(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-hover-card")).toHaveCount(0);
}

export async function expectWorkspaceRowHoverCleared(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  await expect(page.getByTestId(`sidebar-workspace-kebab-${workspaceKey}`)).toBeHidden();
  await expect(page.getByTestId("workspace-hover-card")).toHaveCount(0);
}

export async function expectWorkspaceContextMenuActions(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  const menu = page.getByTestId(`sidebar-workspace-context-menu-${workspaceKey}`);
  await expect(menu.getByRole("button", { name: "Copy path" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Rename workspace" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Archive" })).toBeVisible();
}

export async function openProjectContextMenu(page: Page, projectViewKey: string): Promise<void> {
  const menuTestID = `sidebar-project-context-menu-${projectViewKey}`;
  const anchor = await openContextMenuAtRowPoint(
    page,
    `sidebar-project-row-${projectViewKey}`,
    menuTestID,
  );
  await expectContextMenuAtPointer(page, menuTestID, anchor);
}

export async function closeProjectContextMenu(page: Page, projectViewKey: string): Promise<void> {
  await page.getByTestId(`sidebar-project-context-menu-${projectViewKey}-backdrop`).click();
}

export async function expectProjectContextMenuActions(
  page: Page,
  projectViewKey: string,
): Promise<void> {
  const menu = page.getByTestId(`sidebar-project-context-menu-${projectViewKey}`);
  await expect(menu.getByRole("button", { name: "Open project settings" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Remove project" })).toBeVisible();
}

export async function selectWorkspaceInSidebar(page: Page, workspaceId: string): Promise<void> {
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

async function openWorkspaceSidebarKebab(page: Page, workspaceId: string) {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  return serverId;
}

export async function expectWorkspaceListed(page: Page, name: string): Promise<void> {
  await expect(
    page.locator('[data-testid^="sidebar-workspace-row-"]').filter({ hasText: name }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

// The workspace row kebab and its menu items carry no web ARIA role, so the sidebar
// suite addresses them by the stable test ids the app assigns per workspace — the same
// convention the rename flow uses. The kebab only reveals on hover.
export async function clickArchiveWorkspaceMenuItem(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const serverId = await openWorkspaceSidebarKebab(page, workspaceId);
  const archiveItem = page.getByTestId(`sidebar-workspace-menu-archive-${serverId}:${workspaceId}`);
  await expect(archiveItem).toBeVisible({ timeout: 10_000 });
  await archiveItem.click();
}

export async function pinWorkspaceFromSidebar(page: Page, workspaceId: string): Promise<void> {
  const serverId = await openWorkspaceSidebarKebab(page, workspaceId);
  const pinItem = page.getByTestId(`sidebar-workspace-menu-pin-${serverId}:${workspaceId}`);
  await expect(pinItem).toBeVisible({ timeout: 10_000 });
  await pinItem.click();
}

export async function archiveWorkspaceFromSidebar(page: Page, workspaceId: string): Promise<void> {
  // A clean workspace archives with no prompt. Managed worktree backing may raise
  // a browser confirm for unsynced work, so accept it when present.
  page.once("dialog", (dialog) => void dialog.accept());
  await clickArchiveWorkspaceMenuItem(page, workspaceId);
}

export async function expectWorkspaceAbsentFromSidebar(
  page: Page,
  workspaceId: string,
): Promise<void> {
  await expect(
    page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`),
  ).toHaveCount(0, { timeout: 30_000 });
}

export async function openMobileAgentSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu" }).click();
}

export async function closeMobileAgentSidebar(page: Page): Promise<void> {
  const closeButton = page.getByTestId("sidebar-close");
  await expect(closeButton).toBeInViewport({ ratio: 1, timeout: 5_000 });
  await closeButton.click();
}

// The mobile sidebar panel animates via translateX. Waiting for its header to be fully visible
// prevents a close click from targeting a button while the panel is still moving.
export async function expectMobileAgentSidebarVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("sidebar-sessions")).toBeInViewport({ ratio: 1, timeout: 5_000 });
}

export async function expectMobileAgentSidebarHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("sidebar-sessions")).not.toBeInViewport({ timeout: 5_000 });
}
