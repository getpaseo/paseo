import type { Page, TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import type { SeedDaemonClient } from "../support/helpers/seed-client";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ viewport: MOBILE_VIEWPORT, deviceScaleFactor: 2 });

async function openTabSwitcher(page: Page) {
  await page.getByRole("button", { name: /Switch tabs/ }).click();
  const footer = page.getByRole("button", { name: "New terminal", exact: true });
  await expect(footer).toBeVisible();
  // Visibility alone passes while the sheet is still travelling up from below the viewport.
  await expect
    .poll(async () => {
      const bounds = await footer.boundingBox();
      return bounds ? bounds.y + bounds.height : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
}

async function captureScreen(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name + ".png") });
}

async function createTabFromSwitcher(page: Page, kind: "New agent" | "New terminal") {
  await openTabSwitcher(page);
  await page.getByRole("button", { name: kind, exact: true }).click();
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
}

async function fetchAgentTitle(client: SeedDaemonClient, agentId: string): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

/**
 * Compact "sessions dropdown" rename path. The desktop rename specs drive the right-click
 * `workspace-tab-context-*` menu, which portals into overlay-root and was never broken. This
 * exercises the tab switcher's per-session actions on a phone-sized viewport — the path that
 * regressed when the actions menu presented as a popover instead of a bottom sheet.
 */
test.describe("Workspace session rename (compact tab switcher)", () => {
  test("renames an agent session from the switcher's per-session actions sheet", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.setViewportSize(MOBILE_VIEWPORT);
    const initialTitle = `switcher-rename-${randomUUID().slice(0, 8)}`;
    const session = await seedMockAgentWorkspace({
      repoPrefix: "workspace-switcher-rename-",
      title: initialTitle,
    });

    try {
      await openAgentRoute(page, session);
      await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible({
        timeout: 30_000,
      });

      await captureScreen(page, testInfo, "compact-chat-header");

      // Open the sessions dropdown (a bottom sheet on compact).
      await openTabSwitcher(page);
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" }).first()).toBeVisible(
        {
          timeout: 10_000,
        },
      );

      // Open this session's "…" actions. Before the fix this tried to open a popover-Modal
      // that never surfaced over the sheet on native; it now opens as a stacked sheet.
      const menuBase = `workspace-tab-menu-agent_${session.agentId}`;
      const actionsTrigger = page.getByTestId(`${menuBase}-trigger`);
      await expect(actionsTrigger).toBeVisible({ timeout: 15_000 });
      await actionsTrigger.click();

      const renameItem = page.getByTestId(`${menuBase}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-agent-${session.agentId}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);

      const renamed = "Renamed from the dropdown";
      await input.fill(renamed);
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText(renamed, { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("1");
      await expect.poll(() => fetchAgentTitle(session.client, session.agentId)).toBe(renamed);
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(1);
      await expect(page.getByText("Rename agent", { exact: true })).toBeHidden();
      await captureScreen(page, testInfo, "renamed-tab-in-switcher");
    } finally {
      await session.cleanup();
    }
  });
});

test("switcher footer creates tabs and returns to the existing chat", async ({
  page,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "compact-header-actions-",
    title: "Existing chat",
  });
  try {
    await openAgentRoute(page, session);
    await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("1");

    await createTabFromSwitcher(page, "New terminal");
    await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("2");
    await expect(page.getByTestId("terminal-surface").filter({ visible: true })).toHaveCount(1);
    await captureScreen(page, testInfo, "compact-terminal-header");

    await createTabFromSwitcher(page, "New agent");
    await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("3");
    await expect(
      page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }),
    ).toHaveCount(1);
    await captureScreen(page, testInfo, "compact-draft-header");

    await openTabSwitcher(page);
    await expect(page.getByText("Existing chat", { exact: true })).toBeVisible();
    await captureScreen(page, testInfo, "switcher-three-tabs");
    await page.getByText("Existing chat", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("3");

    await openTabSwitcher(page);
    await expect(page.getByText("Existing chat", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Bottom sheet backdrop" })
      .click({ position: { x: 10, y: 10 } });
    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
    await captureScreen(page, testInfo, "returned-chat-header");
  } finally {
    await session.cleanup();
  }
});
