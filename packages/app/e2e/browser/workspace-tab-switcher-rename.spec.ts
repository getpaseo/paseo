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

for (const titleLines of [2, 3, 0] as const) {
  test(`wraps long tab titles (${titleLines || "unlimited"} lines), shows agent details and persists drag order`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.addInitScript((workspaceTabTitleLines) => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ workspaceTabTitleLines }));
    }, titleLines);
    const longTitle =
      "Plan a community science exhibition with astronomy demonstrations, volunteer schedules and multilingual visitor guides — 为社区科学展览规划天文互动演示、志愿者排班与多语言家庭参观指南";
    const session = await seedMockAgentWorkspace({
      repoPrefix: "tab-list-details-",
      title: longTitle,
      model: "five-minute-stream",
      thinkingOptionId: "high",
    });
    try {
      await openAgentRoute(page, session);
      await expect(page.getByTestId("workspace-tab-switcher-trigger")).toHaveText("1");
      const second = await session.client.createAgent({
        provider: "mock",
        cwd: session.cwd,
        workspaceId: session.workspaceId,
        title: "Review the observatory visitor guide",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });
      await openAgentRoute(page, { workspaceId: session.workspaceId, agentId: second.id });
      await expect(page.getByTestId("workspace-tab-switcher-trigger")).toHaveText("2");
      await openTabSwitcher(page);
      const firstRow = page.getByTestId(`workspace-tab-option-agent_${session.agentId}`);
      const secondRow = page.getByTestId(`workspace-tab-option-agent_${second.id}`);
      await expect(firstRow).toContainText("Five minute stream");
      await expect(firstRow).toContainText("High");
      if (titleLines === 3) {
        await session.client.sendAgentMessage(
          session.agentId,
          "Draft the community observatory visitor guide.",
        );
        await expect(firstRow).toContainText(/High · \d+s/);
        const initialDetails = await firstRow.textContent();
        await expect.poll(() => firstRow.textContent()).not.toBe(initialDetails);
        await session.client.cancelAgent(session.agentId);
        await expect(firstRow).not.toContainText(/High · \d+s/);
      }
      const title = firstRow.getByText(longTitle, { exact: true });
      await expect(title).toBeVisible();
      const layout = await title.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          clamp: style.webkitLineClamp,
          height: node.getBoundingClientRect().height,
          fontSize: parseFloat(style.fontSize),
        };
      });
      expect(layout.height).toBeGreaterThan(layout.fontSize * 1.5);
      if (titleLines > 0) expect(layout.clamp).toBe(String(titleLines));
      else expect(layout.clamp).not.toBe("1");
      await captureScreen(page, testInfo, `title-lines-${titleLines || "unlimited"}`);

      const source = await firstRow.boundingBox();
      const target = await secondRow.boundingBox();
      if (!source || !target) throw new Error("Tab rows were not laid out");
      await page.mouse.move(source.x + 25, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(source.x + 25, source.y + source.height / 2 + 12, { steps: 4 });
      await page.mouse.move(target.x + 25, target.y + target.height - 4, { steps: 20 });
      await page.mouse.up();
      const rows = page.locator('[data-testid^="workspace-tab-option-"]');
      await expect(rows.first()).toHaveAttribute(
        "data-testid",
        `workspace-tab-option-agent_${second.id}`,
      );
      await captureScreen(page, testInfo, "reordered-tabs");
      await page
        .getByRole("button", { name: "Bottom sheet backdrop" })
        .click({ position: { x: 10, y: 10 } });
      await page.reload();
      await openTabSwitcher(page);
      await expect(rows.first()).toHaveAttribute(
        "data-testid",
        `workspace-tab-option-agent_${second.id}`,
      );
      await firstRow.click();
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
      await expect(page.getByTestId("workspace-tab-switcher-trigger")).toHaveText("2");
    } finally {
      await session.cleanup();
    }
  });
}

test("tab title line preference can be changed in Appearance and survives reload", async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  const trigger = page.getByTestId("workspace-tab-title-lines");
  await expect(trigger).toHaveText("3 lines");
  for (const [label, value] of [
    ["2 lines", 2],
    ["Unlimited", 0],
    ["3 lines", 3],
  ] as const) {
    await trigger.click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    await expect(trigger).toHaveText(label);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}").workspaceTabTitleLines,
        ),
      )
      .toBe(value);
    await page.reload();
    await expect(trigger).toHaveText(label);
  }
});
