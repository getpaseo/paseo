import { expect, type Page } from "@playwright/test";

export function requireServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

export async function selectWorkspaceInSidebar(page: Page, workspaceId: string): Promise<void> {
  const row = page.getByTestId(`sidebar-workspace-row-${requireServerId()}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

export async function expectWorkspaceListed(page: Page, name: string): Promise<void> {
  await expect(
    page.locator('[data-testid^="sidebar-workspace-row-"]').filter({ hasText: name }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

interface CdpWsFrameEvent {
  response: { opcode: number; payloadData: string };
}

const pageMonitors = new WeakMap<Page, { count: number }>();

/**
 * Installs a CDP WebSocket frame monitor. Must be called BEFORE page.goto() so the
 * WebSocket connection is captured. Counts outgoing `fetch_workspaces_request` frames.
 */
export async function installWorkspaceFetchMonitor(page: Page): Promise<void> {
  const state = { count: 0 };
  pageMonitors.set(page, state);
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  session.on("Network.webSocketFrameSent", (event: CdpWsFrameEvent) => {
    if (
      event.response.opcode === 1 &&
      event.response.payloadData.includes('"fetch_workspaces_request"')
    ) {
      state.count++;
    }
  });
}

/**
 * Asserts the workspace-list query is active (expected=true) or paused (expected=false).
 * true: polls until at least one fetch_workspaces_request is observed.
 * false: waits 400 ms and asserts the frame count did not increase.
 */
export async function expectWorkspaceListSubscribed(page: Page, expected: boolean): Promise<void> {
  const state = pageMonitors.get(page);
  if (!state) {
    throw new Error("Call installWorkspaceFetchMonitor before expectWorkspaceListSubscribed");
  }
  if (expected) {
    await expect.poll(() => state.count, { timeout: 10_000 }).toBeGreaterThan(0);
  } else {
    const before = state.count;
    await page.waitForTimeout(400);
    expect(state.count).toBe(before);
  }
}

export async function closeSidebar(page: Page): Promise<void> {
  await page.getByTestId("menu-button").click();
}

export async function openMobileAgentSidebar(page: Page): Promise<void> {
  await page.getByTestId("menu-button").click();
}

// force=true: the overlay covers the button when the mobile sidebar is open.
export async function closeMobileAgentSidebar(page: Page): Promise<void> {
  await page.getByTestId("menu-button").click({ force: true });
}

// The mobile sidebar panel animates via translateX; toBeInViewport reflects the rendered position.
export async function expectMobileAgentSidebarVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("sidebar-sessions")).toBeInViewport({ timeout: 5_000 });
}

export async function expectMobileAgentSidebarHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("sidebar-sessions")).not.toBeInViewport({ timeout: 5_000 });
}
