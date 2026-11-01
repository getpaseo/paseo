import type { Page, TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
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

test.describe("Compact workspace header swipes", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ hasTouch: true, isMobile: true });

  async function settleGesture(page: Page) {
    // Let queued gesture callbacks and the resulting React render reach the browser.
    await page.evaluate(async () => {
      await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    });
  }

  async function swipeHeader(
    page: Page,
    deltaX: number,
    options: TouchSwipeOptions & { fromSwitcher?: boolean } = {},
  ) {
    const title = await page.getByTestId("workspace-header-title").boundingBox();
    if (!title) throw new Error("Workspace header is not visible");
    const trigger = await page.getByTestId("workspace-tab-switcher-trigger").boundingBox();
    if (!trigger) throw new Error("Tab switcher is not visible");
    const x = options.fromSwitcher ? trigger.x + trigger.width / 2 : 150;
    const y = options.fromSwitcher ? trigger.y + trigger.height / 2 : title.y + title.height / 2;
    await touchSwipe(page, { x, y }, deltaX, options);
  }

  interface TouchSwipeOptions {
    deltaY?: number;
    cancel?: boolean;
    secondFinger?: boolean;
  }

  interface HeaderSwipePoint {
    x: number;
    y: number;
  }

  async function touchSwipe(
    page: Page,
    from: HeaderSwipePoint,
    deltaX: number,
    options: TouchSwipeOptions = {},
  ) {
    const { x, y } = from;
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 8; step++) {
        const point = {
          x: x + (deltaX * step) / 8,
          y: y + ((options.deltaY ?? 0) * step) / 8,
          id: 0,
        };
        const touchPoints =
          options.secondFinger && step >= 4
            ? [point, { x: point.x + 20, y: point.y + 20, id: 1 }]
            : [point];
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints,
        });
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: options.cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    } finally {
      await cdp.detach();
    }
    await settleGesture(page);
    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
  }

  async function headerSwipePoints(page: Page) {
    const area = await page.getByTestId("workspace-tab-swipe-area").boundingBox();
    if (!area) throw new Error("Workspace tab swipe area is not visible");
    const title = await page.getByTestId("workspace-header-title").boundingBox();
    if (!title) throw new Error("Workspace header is not visible");
    const menu = await page.getByTestId("menu-button").boundingBox();
    if (!menu) throw new Error("Menu button is not visible");
    const explorer = await page.getByTestId("workspace-explorer-toggle").boundingBox();
    if (!explorer) throw new Error("Explorer toggle is not visible");
    const midY = title.y + title.height / 2;
    const belowY = area.y + area.height + 120;
    return {
      title: { x: 150, y: midY },
      menu: { x: menu.x + menu.width / 2, y: menu.y + menu.height / 2 },
      explorer: { x: explorer.x + explorer.width / 2, y: explorer.y + explorer.height / 2 },
      // Top padding strip of the swipe area: above the island row, no controls.
      gap: { x: MOBILE_VIEWPORT.width / 2, y: area.y + 4 },
      leftEdge: { x: area.x + 4, y: midY },
      rightEdge: { x: area.x + area.width - 4, y: midY },
      belowLeft: { x: 10, y: belowY },
      belowRight: { x: MOBILE_VIEWPORT.width - 10, y: belowY },
      belowCenter: { x: MOBILE_VIEWPORT.width / 2, y: belowY },
      belowInnerLeft: { x: 60, y: belowY },
      belowInnerRight: { x: MOBILE_VIEWPORT.width - 60, y: belowY },
    };
  }

  async function expectPanelsClosed(page: Page) {
    await expect(page.getByTestId("agent-list-backdrop")).toHaveCount(0);
    await expect(page.getByTestId("file-explorer-backdrop")).toHaveCount(0);
  }

  async function closePanels(page: Page, which: "agent-list" | "file-explorer") {
    // The open panel covers the header, so closing uses the overlay's own close
    // control — never a covered workspace button.
    const closeButton = page.getByTestId(
      which === "agent-list" ? "sidebar-close" : "explorer-close",
    );
    const backdrop = page.getByTestId(`${which}-backdrop`);
    await expect(backdrop).toBeVisible();
    await expect(closeButton).toBeVisible();
    await closeButton.tap();
    await expect(backdrop).toHaveCount(0);
  }

  test("swipes between open tabs in switcher order", async ({ page }, testInfo) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "compact-header-swipe-",
      title: "Existing chat",
    });
    try {
      await openAgentRoute(page, session);
      const composer = page
        .getByRole("textbox", { name: "Message agent..." })
        .filter({ visible: true });
      await composer.fill("Retained chat draft");
      await createTabFromSwitcher(page, "New terminal");
      await expect(page.getByTestId("terminal-surface").filter({ visible: true })).toHaveCount(1);
      await createTabFromSwitcher(page, "New agent");
      await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("3");
      await composer.fill("Retained new agent draft");

      await swipeHeader(page, 130);
      await expect(page.getByTestId("terminal-surface").filter({ visible: true })).toHaveCount(1);
      await captureScreen(page, testInfo, "swiped-to-terminal");

      await swipeHeader(page, 130);
      await expect(composer).toHaveValue("Retained chat draft");
      await swipeHeader(page, 130);
      await expect(composer).toHaveValue("Retained chat draft");
      await swipeHeader(page, -130);
      await expect(page.getByTestId("terminal-surface").filter({ visible: true })).toHaveCount(1);
      await swipeHeader(page, -130);
      await expect(composer).toHaveValue("Retained new agent draft");
      await swipeHeader(page, -130);
      await expect(composer).toHaveValue("Retained new agent draft");
      await captureScreen(page, testInfo, "swiped-to-draft");
    } finally {
      await session.cleanup();
    }
  });

  test("switches persisted tabs while workspace and chat responses are pending", async ({
    page,
  }, testInfo) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "compact-header-loading-",
      title: "Loading chat",
    });
    const gate = await installDaemonWebSocketGate(page);
    try {
      await openAgentRoute(page, session);
      await createTabFromSwitcher(page, "New agent");
      const composer = page
        .getByRole("textbox", { name: "Message agent..." })
        .filter({ visible: true });
      await composer.fill("Draft available before the chat loads");
      await openTabSwitcher(page);
      await page.getByText("Loading chat", { exact: true }).click();
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);

      gate.holdNextServerMessage("checkout_status_response");
      gate.holdTimelineResponses(session.agentId);
      await page.reload({ waitUntil: "commit" });
      await gate.waitForHeldServerMessage("checkout_status_response");
      await gate.waitForHeldTimelineResponse();
      await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("2");
      await expect(page.getByTestId("agent-loading").filter({ visible: true })).toHaveCount(1);
      await captureScreen(page, testInfo, "pending-workspace-and-chat");

      const area = await page.getByTestId("workspace-tab-swipe-area").boundingBox();
      if (!area) throw new Error("Workspace header is not visible while loading");
      await touchSwipe(page, { x: 150, y: area.y + area.height - 24 }, -130);
      await expect(composer).toHaveValue("Draft available before the chat loads");
      await captureScreen(page, testInfo, "swiped-before-responses");

      await touchSwipe(page, { x: 150, y: area.y + area.height - 24 }, 130);
      await expect(composer).toHaveCount(0);
      await openTabSwitcher(page);
      await page.getByText("New Agent", { exact: true }).click();
      await expect(composer).toHaveValue("Draft available before the chat loads");
      gate.releaseHeldServerMessage("checkout_status_response");
      gate.releaseHeldTimelineResponses();
      await expect(page.getByTestId("workspace-header-title")).toBeVisible();
      await expect(composer).toHaveValue("Draft available before the chat loads");
    } finally {
      gate.releaseHeldTimelineResponses();
      await session.cleanup();
    }
  });

  test("ignores incomplete gestures, multiple fingers and mouse drags while preserving taps", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "compact-header-gesture-",
      title: "Touch gesture chat",
    });
    try {
      await openAgentRoute(page, session);
      const composer = page
        .getByRole("textbox", { name: "Message agent..." })
        .filter({ visible: true });
      await composer.fill("Single tab draft");
      await swipeHeader(page, -130);
      await expect(composer).toHaveValue("Single tab draft");
      await swipeHeader(page, 130);
      await expect(composer).toHaveValue("Single tab draft");

      await createTabFromSwitcher(page, "New agent");
      await composer.fill("Second tab draft");
      await swipeHeader(page, 30);
      await expect(composer).toHaveValue("Second tab draft");
      await swipeHeader(page, 10, { deltaY: 130 });
      await expect(composer).toHaveValue("Second tab draft");
      await swipeHeader(page, 100, { deltaY: 100 });
      await expect(composer).toHaveValue("Second tab draft");
      await swipeHeader(page, 130, { cancel: true });
      await expect(composer).toHaveValue("Second tab draft");
      await swipeHeader(page, 130, { secondFinger: true });
      await expect(composer).toHaveValue("Second tab draft");

      const title = await page.getByTestId("workspace-header-title").boundingBox();
      if (!title) throw new Error("Workspace header is not visible");
      await page.mouse.move(150, title.y + title.height / 2);
      await page.mouse.down();
      await page.mouse.move(280, title.y + title.height / 2, { steps: 8 });
      await page.mouse.up();
      await settleGesture(page);
      await expect(composer).toHaveValue("Second tab draft");

      // A swipe starting on the existing trigger must not also open its sheet.
      await swipeHeader(page, 80, { fromSwitcher: true });
      await expect(composer).toHaveValue("Single tab draft");
      await page.getByTestId("workspace-tab-switcher-trigger").tap();
      await expect(page.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
      await page.getByText("New Agent", { exact: true }).click();
      await expect(composer).toHaveValue("Second tab draft");
    } finally {
      await session.cleanup();
    }
  });

  test("header row owns horizontal swipes and no-op gestures never open panels", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "compact-header-ownership-",
      title: "Header ownership chat",
    });
    try {
      await openAgentRoute(page, session);
      const composer = page
        .getByRole("textbox", { name: "Message agent..." })
        .filter({ visible: true });
      await composer.fill("One tab draft");
      await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("1");

      const points = await headerSwipePoints(page);
      const starts: Array<[HeaderSwipePoint, number]> = [
        [points.title, -140],
        [points.menu, 140],
        [points.explorer, -140],
        [points.gap, -140],
        // Edge swipes travel inward so every touch point stays in the viewport.
        [points.leftEdge, 140],
        [points.rightEdge, -140],
      ];
      for (const [from, deltaX] of starts) {
        await touchSwipe(page, from, deltaX);
        await expect(composer).toHaveValue("One tab draft");
        await expectPanelsClosed(page);
      }

      await createTabFromSwitcher(page, "New agent");
      await composer.fill("Second tab draft");
      await touchSwipe(page, points.menu, 140);
      await expect(composer).toHaveValue("One tab draft");
      await expectPanelsClosed(page);
      await touchSwipe(page, points.explorer, -140);
      await expect(composer).toHaveValue("Second tab draft");
      await expectPanelsClosed(page);

      // Gaps and extreme edges switch tabs exactly like the title does.
      await touchSwipe(page, points.leftEdge, 140);
      await expect(composer).toHaveValue("One tab draft");
      await expectPanelsClosed(page);
      await touchSwipe(page, points.rightEdge, -140);
      await expect(composer).toHaveValue("Second tab draft");
      await expectPanelsClosed(page);
      await touchSwipe(page, points.gap, 140);
      await expect(composer).toHaveValue("One tab draft");
      await expectPanelsClosed(page);
      await touchSwipe(page, points.gap, -140);
      await expect(composer).toHaveValue("Second tab draft");
      await expectPanelsClosed(page);

      // Boundary no-ops stay silent; edge swipes still travel inward.
      await touchSwipe(page, points.title, -140);
      await expect(composer).toHaveValue("Second tab draft");
      await touchSwipe(page, points.rightEdge, -140);
      await expect(composer).toHaveValue("Second tab draft");
      await touchSwipe(page, points.title, 140);
      await expect(composer).toHaveValue("One tab draft");
      await touchSwipe(page, points.leftEdge, 140);
      await expect(composer).toHaveValue("One tab draft");
      await expectPanelsClosed(page);

      // Toggle proof: taps open their panels, so no swipe left one behind. A swipe
      // that had spuriously opened a panel would invert the toggle and fail here.
      await page.getByTestId("menu-button").tap();
      await closePanels(page, "agent-list");
      await page.getByTestId("workspace-explorer-toggle").tap();
      await closePanels(page, "file-explorer");
    } finally {
      await session.cleanup();
    }
  });

  test("panel swipes only start below the header within the 32px edges", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "compact-panel-edges-",
      title: "Panel edge chat",
    });
    try {
      await openAgentRoute(page, session);
      const composer = page
        .getByRole("textbox", { name: "Message agent..." })
        .filter({ visible: true });
      await composer.fill("Edge draft");

      const points = await headerSwipePoints(page);
      await touchSwipe(page, points.belowLeft, 150);
      await closePanels(page, "agent-list");

      await touchSwipe(page, points.belowRight, -150);
      await closePanels(page, "file-explorer");

      await touchSwipe(page, points.belowCenter, 150);
      await expect(composer).toHaveValue("Edge draft");
      await touchSwipe(page, points.belowCenter, -150);
      await expect(composer).toHaveValue("Edge draft");
      await touchSwipe(page, points.belowInnerLeft, 150);
      await touchSwipe(page, points.belowInnerRight, -150);
      await expect(composer).toHaveValue("Edge draft");
      await expectPanelsClosed(page);

      // Toggle proof: nothing above opened a panel behind our back.
      await page.getByTestId("menu-button").tap();
      await closePanels(page, "agent-list");
    } finally {
      await session.cleanup();
    }
  });
});
