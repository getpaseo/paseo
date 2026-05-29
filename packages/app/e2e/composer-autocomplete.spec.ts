import { expect, test, type Page } from "./fixtures";
import { composerLocator, expectComposerVisible } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import { expectWorkspaceTabVisible } from "./helpers/archive-tab";
import { daemonWsRoutePattern } from "./helpers/daemon-port";

const TEST_COMMANDS = [
  {
    name: "tdd",
    description: "Write a red test, verify it fails for the right reason, implement to green",
    argumentHint: "",
  },
  {
    name: "help",
    description: "Show help for the current agent session and available slash commands",
    argumentHint: "",
  },
  {
    name: "hello",
    description: "Insert a friendly greeting prompt into the current composer",
    argumentHint: "",
  },
  {
    name: "heapdump",
    description: "Dump the JavaScript heap for local desktop debugging",
    argumentHint: "",
  },
  {
    name: "health",
    description: "Show runtime health checks and connection diagnostics",
    argumentHint: "",
  },
  {
    name: "history",
    description: "Summarize recent session history",
    argumentHint: "",
  },
  {
    name: "handoff",
    description: "Prepare a complete handoff note for another agent",
    argumentHint: "[agent]",
  },
  {
    name: "hover",
    description: "Audit hover behavior in desktop web surfaces",
    argumentHint: "",
  },
  {
    name: "harness",
    description: "Inspect the local test harness configuration",
    argumentHint: "",
  },
  {
    name: "hydrate",
    description: "Refresh persisted state used by the current workspace",
    argumentHint: "",
  },
  {
    name: "highlight",
    description: "Highlight important changes in the active diff",
    argumentHint: "",
  },
  {
    name: "home",
    description: "Navigate back to the workspace home surface",
    argumentHint: "",
  },
  {
    name: "host",
    description: "Inspect host connection metadata",
    argumentHint: "",
  },
] as const;

interface PopoverFrame {
  exists: boolean;
  top: number;
  bottom: number;
  height: number;
  opacity: number;
  display: string;
  visibility: string;
  timestamp: number;
}

interface PopoverFrameRecorderWindow extends Window {
  __composerAutocompleteFrames?: PopoverFrame[];
  __stopComposerAutocompleteFrameRecorder?: () => void;
}

async function getTopTestIdAtPoint(page: Page, x: number, y: number) {
  return page.evaluate(
    ([pointX, pointY]) => {
      const element = document.elementFromPoint(pointX, pointY);
      return element?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
    },
    [x, y],
  );
}

async function installListCommandsStub(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      server.send(message);
    });

    server.onMessage((message) => {
      if (typeof message !== "string") {
        ws.send(message);
        return;
      }

      try {
        const parsed = JSON.parse(message) as {
          type?: string;
          message?: {
            type?: string;
            payload?: {
              commands?: unknown;
              error?: string | null;
            };
          };
        };
        if (
          parsed.type === "session" &&
          parsed.message?.type === "list_commands_response" &&
          parsed.message.payload
        ) {
          parsed.message.payload.commands = TEST_COMMANDS;
          parsed.message.payload.error = null;
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch {
        // Forward non-JSON frames unchanged.
      }

      ws.send(message);
    });
  });
}

async function openReadyMockAgent(
  page: Page,
  options?: { expectWorkspaceTab?: boolean },
): Promise<{
  cleanup: () => Promise<void>;
}> {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "autocomplete-popover-",
    title: "Autocomplete popover regression",
  });

  try {
    await openAgentRoute(page, session);
    if (options?.expectWorkspaceTab !== false) {
      await expectWorkspaceTabVisible(page, session.agentId);
    }
    await expectComposerVisible(page);
    return { cleanup: session.cleanup };
  } catch (error) {
    await session.cleanup();
    throw error;
  }
}

async function visiblePopoverBox(
  page: Page,
): Promise<{ top: number; bottom: number; height: number }> {
  const popover = page.getByTestId("composer-autocomplete-popover");
  await expect(popover).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        popover.evaluate((element) => {
          const style = window.getComputedStyle(element);
          return Number(style.opacity);
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0.95);
  const box = await popover.boundingBox();
  if (!box) {
    throw new Error("Autocomplete popover did not produce a bounding box.");
  }
  return {
    top: box.y,
    bottom: box.y + box.height,
    height: box.height,
  };
}

async function startPopoverFrameRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as PopoverFrameRecorderWindow;
    win.__composerAutocompleteFrames = [];
    let active = true;

    const record = () => {
      if (!active) return;

      const element = document.querySelector('[data-testid="composer-autocomplete-popover"]');
      if (element instanceof HTMLElement) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        win.__composerAutocompleteFrames?.push({
          exists: true,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          opacity: Number(style.opacity),
          display: style.display,
          visibility: style.visibility,
          timestamp: performance.now(),
        });
      } else {
        win.__composerAutocompleteFrames?.push({
          exists: false,
          top: 0,
          bottom: 0,
          height: 0,
          opacity: 0,
          display: "none",
          visibility: "hidden",
          timestamp: performance.now(),
        });
      }

      window.requestAnimationFrame(record);
    };

    win.__stopComposerAutocompleteFrameRecorder = () => {
      active = false;
    };
    window.requestAnimationFrame(record);
  });
}

async function stopPopoverFrameRecorder(page: Page): Promise<PopoverFrame[]> {
  return page.evaluate(() => {
    const win = window as PopoverFrameRecorderWindow;
    win.__stopComposerAutocompleteFrameRecorder?.();
    return win.__composerAutocompleteFrames ?? [];
  });
}

function visiblePopoverFrames(frames: PopoverFrame[]): PopoverFrame[] {
  return frames.filter(
    (frame) =>
      frame.exists &&
      frame.height > 0 &&
      frame.opacity > 0.95 &&
      frame.display !== "none" &&
      frame.visibility !== "hidden",
  );
}

function formatFrame(frame: PopoverFrame | undefined): string {
  if (!frame) return "none";
  return JSON.stringify({
    top: Math.round(frame.top),
    bottom: Math.round(frame.bottom),
    height: Math.round(frame.height),
    opacity: frame.opacity,
  });
}

function expectPopoverFramesStable(frames: PopoverFrame[]): void {
  const visibleFrames = visiblePopoverFrames(frames);
  expect(visibleFrames.length).toBeGreaterThan(0);

  const finalFrame = visibleFrames[visibleFrames.length - 1];
  const jumpingFrame = visibleFrames.find(
    (frame) =>
      Math.abs(frame.top - finalFrame.top) > 4 ||
      Math.abs(frame.bottom - finalFrame.bottom) > 4 ||
      Math.abs(frame.height - finalFrame.height) > 4,
  );

  expect(
    jumpingFrame,
    `expected first visible popover paint to be stable; first=${formatFrame(
      visibleFrames[0],
    )} jumping=${formatFrame(jumpingFrame)} final=${formatFrame(finalFrame)}`,
  ).toBeUndefined();
}

function expectPopoverDoesNotDisappearAfterFirstVisible(frames: PopoverFrame[]): void {
  const firstVisibleIndex = frames.findIndex(
    (frame) =>
      frame.exists &&
      frame.height > 0 &&
      frame.opacity > 0.95 &&
      frame.display !== "none" &&
      frame.visibility !== "hidden",
  );
  expect(firstVisibleIndex).toBeGreaterThanOrEqual(0);

  const hiddenFrame = frames
    .slice(firstVisibleIndex)
    .find((frame) => !frame.exists || frame.opacity < 0.95);
  expect(
    hiddenFrame,
    `expected mounted popover to stay visible while filtering; hidden=${formatFrame(hiddenFrame)}`,
  ).toBeUndefined();
}

test.describe("Composer autocomplete", () => {
  test("does not flash at the wrong position on the first slash command paint", async ({
    page,
  }) => {
    await installListCommandsStub(page);
    const agent = await openReadyMockAgent(page);

    try {
      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });
      await input.click();

      await startPopoverFrameRecorder(page);
      await page.keyboard.type("/");
      await expect(page.getByText("/help", { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(250);
      const frames = await stopPopoverFrameRecorder(page);

      expectPopoverFramesStable(frames);
    } finally {
      await agent.cleanup();
    }
  });

  test("does not jump when deleting a slash command search", async ({ page }) => {
    await installListCommandsStub(page);
    const agent = await openReadyMockAgent(page);

    try {
      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });

      await input.fill("/he");
      const popover = page.getByTestId("composer-autocomplete-popover");
      await expect(popover.getByText("/help", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      const beforeDelete = await visiblePopoverBox(page);

      await input.press("Backspace");
      await expect(input).toHaveValue("/h");
      await expect(popover.getByText("/history", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      const afterDelete = await visiblePopoverBox(page);

      expect(Math.abs(afterDelete.bottom - beforeDelete.bottom)).toBeLessThanOrEqual(4);
      expect(afterDelete.height).toBeGreaterThan(beforeDelete.height);
    } finally {
      await agent.cleanup();
    }
  });

  test("shrinks to filtered slash command results without moving the bottom edge", async ({
    page,
  }) => {
    await installListCommandsStub(page);
    const agent = await openReadyMockAgent(page);

    try {
      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });

      await input.fill("/");
      const popover = page.getByTestId("composer-autocomplete-popover");
      await expect(popover.getByText("/help", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      const allCommands = await visiblePopoverBox(page);

      await input.fill("/tdd");
      await expect(popover.getByText("/tdd", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      const oneCommand = await visiblePopoverBox(page);

      expect(Math.abs(oneCommand.bottom - allCommands.bottom)).toBeLessThanOrEqual(4);
      expect(oneCommand.height).toBeLessThan(allCommands.height - 40);
    } finally {
      await agent.cleanup();
    }
  });

  test("stays visible while filtering slash command results", async ({ page }) => {
    await installListCommandsStub(page);
    const agent = await openReadyMockAgent(page);

    try {
      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });

      await input.fill("/");
      const popover = page.getByTestId("composer-autocomplete-popover");
      await expect(popover.getByText("/help", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });

      await startPopoverFrameRecorder(page);
      await page.keyboard.type("tdd", { delay: 40 });
      await expect(popover.getByText("/tdd", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(250);
      const frames = await stopPopoverFrameRecorder(page);

      expectPopoverDoesNotDisappearAfterFirstVisible(frames);
    } finally {
      await agent.cleanup();
    }
  });

  test("stays anchored to the composer when the desktop sidebar is open", async ({ page }) => {
    await installListCommandsStub(page);
    const agent = await openReadyMockAgent(page);

    try {
      await expect(page.getByTestId("sidebar-sessions")).toBeVisible({ timeout: 30_000 });
      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });

      await input.fill("/");
      const popover = page.getByTestId("composer-autocomplete-popover");
      await expect(popover.getByText("/help", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });

      const composerBox = await page.getByTestId("message-input-root").boundingBox();
      const popoverBox = await popover.boundingBox();
      expect(composerBox).not.toBeNull();
      expect(popoverBox).not.toBeNull();

      expect(Math.abs(popoverBox!.x - composerBox!.x)).toBeLessThanOrEqual(4);
      expect(Math.abs(popoverBox!.width - composerBox!.width)).toBeLessThanOrEqual(4);
    } finally {
      await agent.cleanup();
    }
  });

  test.describe("compact sidebar layering", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("keeps the mobile agent sidebar above autocomplete", async ({ page }) => {
      await installListCommandsStub(page);
      const agent = await openReadyMockAgent(page, { expectWorkspaceTab: false });

      try {
        const input = composerLocator(page);
        await expect(input).toBeEditable({ timeout: 30_000 });

        await input.fill("/");
        const popover = page.getByTestId("composer-autocomplete-popover");
        await expect(popover.getByText("/help", { exact: true }).first()).toBeVisible({
          timeout: 30_000,
        });

        await page.getByRole("button", { name: "Open menu" }).click();
        await expect(page.getByTestId("sidebar-sessions")).toBeInViewport({ timeout: 5_000 });

        const popoverBox = await popover.boundingBox();
        expect(popoverBox).not.toBeNull();

        const topTestId = await getTopTestIdAtPoint(
          page,
          popoverBox!.x + popoverBox!.width / 2,
          popoverBox!.y + popoverBox!.height / 2,
        );

        expect(topTestId).not.toBe("composer-autocomplete-popover");
      } finally {
        await agent.cleanup();
      }
    });
  });
});
