import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { gotoHome } from "./app";

export async function openNewAgentComposer(page: Page): Promise<void> {
  await gotoHome(page);
}

/**
 * Wait for the sidebar to show at least one project row, indicating that the
 * WebSocket connection is up and workspace hydration has completed.
 */
export async function waitForSidebarHydration(page: Page, timeout = 60_000): Promise<void> {
  await page
    .locator('[data-testid^="sidebar-project-row-"]')
    .first()
    .waitFor({ state: "visible", timeout });
}

export function workspaceLabelFromPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateWorkspaceIds(inputPath: string): string[] {
  const trimmed = inputPath.replace(/\/+$/, "");
  const candidates = new Set<string>([trimmed]);
  if (trimmed.startsWith("/var/")) {
    candidates.add(`/private${trimmed}`);
  }
  if (trimmed.startsWith("/private/var/")) {
    candidates.add(trimmed.replace(/^\/private/, ""));
  }
  return Array.from(candidates);
}

function workspaceRowLocator(page: Page, serverId: string, workspacePath: string) {
  const ids = candidateWorkspaceIds(workspacePath).map(
    (id) => `[data-testid="sidebar-workspace-row-${serverId}:${id}"]`,
  );
  return page.locator(ids.join(",")).first();
}

export async function expectSidebarWorkspaceSelected(input: {
  page: Page;
  serverId: string;
  workspaceId: string;
  selected?: boolean;
}): Promise<void> {
  const row = workspaceRowLocator(input.page, input.serverId, input.workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const expected = input.selected === false ? "false" : "true";

  const hasDataSelected = await row.getAttribute("data-selected");
  if (hasDataSelected !== null) {
    await expect(row).toHaveAttribute("data-selected", expected, {
      timeout: 30_000,
    });
    return;
  }

  await expect(row).toHaveAttribute("aria-selected", expected, {
    timeout: 30_000,
  });
}

export async function switchWorkspaceViaSidebar(input: {
  page: Page;
  serverId: string;
  targetWorkspacePath: string;
}): Promise<void> {
  const row = workspaceRowLocator(input.page, input.serverId, input.targetWorkspacePath);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const targetWorkspaceRoute = buildHostWorkspaceRoute(input.serverId, input.targetWorkspacePath);
  await expect(input.page).toHaveURL(new RegExp(escapeRegex(targetWorkspaceRoute)), {
    timeout: 30_000,
  });
}

/**
 * Wait for a workspace's sidebar row to appear, confirming the workspace
 * descriptor has been hydrated into the session store.
 */
export async function waitForWorkspaceInSidebar(
  page: Page,
  input: { serverId: string; workspaceId: string },
): Promise<void> {
  const candidates = candidateWorkspaceIds(input.workspaceId);
  const selector = candidates
    .map((id) => `[data-testid="sidebar-workspace-row-${input.serverId}:${id}"]`)
    .join(",");
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 60_000 });
}

export async function expectWorkspaceHeader(
  page: Page,
  input: { title: string; subtitle: string },
): Promise<void> {
  const titleLocator = page.getByTestId("workspace-header-title").filter({ visible: true });
  const subtitleLocator = page.getByTestId("workspace-header-subtitle").filter({ visible: true });

  await expect(titleLocator.first()).toHaveText(input.title, {
    timeout: 30_000,
  });
  await expect(subtitleLocator.first()).toHaveText(input.subtitle, {
    timeout: 30_000,
  });
}

export async function expectReconnectingToastVisible(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(page.getByTestId("agent-reconnecting-toast")).toBeVisible({
    timeout: options?.timeout ?? 30_000,
  });
}

export async function expectReconnectingToastGone(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(page.getByTestId("agent-reconnecting-toast")).toHaveCount(0, {
    timeout: options?.timeout ?? 30_000,
  });
}

export async function expectHostConnectingOrOffline(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(
    page.getByText(/^Connecting$|localhost is offline|Cannot reach localhost/i),
  ).toBeVisible({ timeout: options?.timeout ?? 30_000 });
}

export async function expectMenuButtonVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("menu-button")).toBeVisible();
}

export async function expectWorkspaceHeaderAbsent(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-header-title")).toHaveCount(0);
}

export function workspaceDeckEntryLocator(page: Page, serverId: string, workspaceId: string) {
  return page.getByTestId(`workspace-deck-entry-${serverId}:${workspaceId}`);
}

export async function expectWorkspaceDeckEntryCount(page: Page, count: number): Promise<void> {
  await expect(page.locator('[data-testid^="workspace-deck-entry-"]')).toHaveCount(count);
}

export async function seedWorkspaceActivity(page: Page, marker: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message agent..." });
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(marker);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
}
