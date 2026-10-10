import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

type WebSocketMessage = string | Buffer;

const COMPACT_VIEWPORT = { width: 390, height: 520 };

function parseSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    return envelope.type === "session" && envelope.message && typeof envelope.message === "object"
      ? (envelope.message as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getToolCallStatus(
  message: WebSocketMessage,
  agentId: string,
): { callId: string; status: string } | null {
  const sessionMessage = parseSessionMessage(message);
  if (sessionMessage?.type !== "agent_stream") {
    return null;
  }
  const payload = sessionMessage.payload as Record<string, unknown> | undefined;
  if (payload?.agentId !== agentId) {
    return null;
  }
  const event = payload.event as Record<string, unknown> | undefined;
  const item = event?.item as Record<string, unknown> | undefined;
  return event?.type === "timeline" &&
    item?.type === "tool_call" &&
    typeof item.callId === "string" &&
    typeof item.status === "string"
    ? { callId: item.callId, status: item.status }
    : null;
}

function cloneToolCallWithId(
  message: WebSocketMessage,
  callId: string,
  sequenceOffset: number,
): string {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  const envelope = JSON.parse(raw) as {
    message?: { payload?: { seq?: number; event?: { item?: { callId?: string } } } };
  };
  const payload = envelope.message?.payload;
  const item = payload?.event?.item;
  if (!payload || !item?.callId || typeof payload.seq !== "number") {
    throw new Error("Expected a tool-call session message");
  }
  item.callId = callId;
  payload.seq += sequenceOffset;
  return JSON.stringify(envelope);
}

function shiftTimelineSequence(
  message: WebSocketMessage,
  sequenceOffset: number,
): WebSocketMessage {
  if (sequenceOffset === 0) {
    return message;
  }
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { message?: { payload?: { seq?: number } } };
    const payload = envelope.message?.payload;
    if (typeof payload?.seq !== "number") {
      return message;
    }
    payload.seq += sequenceOffset;
    return JSON.stringify(envelope);
  } catch {
    return message;
  }
}

async function holdStreamAfterFirstCompletedToolCall(page: Page, agentId: string) {
  let firstCallId: string | null = null;
  let firstCompletedMessage: WebSocketMessage | null = null;
  let isHolding = false;
  let sequenceOffset = 0;
  const heldMessages: WebSocketMessage[] = [];
  let sendToPage: ((message: WebSocketMessage) => void) | null = null;
  let resolveFirstCompleted!: () => void;
  const firstCompleted = new Promise<void>((resolve) => {
    resolveFirstCompleted = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    sendToPage = (message) => ws.send(message);
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (isHolding) {
        heldMessages.push(message);
        return;
      }

      ws.send(shiftTimelineSequence(message, sequenceOffset));
      const toolCall = getToolCallStatus(message, agentId);
      firstCallId ??= toolCall?.callId ?? null;
      if (toolCall?.callId === firstCallId && toolCall.status === "completed") {
        firstCompletedMessage = message;
        isHolding = true;
        resolveFirstCompleted();
      }
    });
  });

  return {
    waitForFirstCompleted: () => firstCompleted,
    release(extraCompletedCalls = 0) {
      isHolding = false;
      if (extraCompletedCalls > 0 && (!firstCallId || !firstCompletedMessage)) {
        throw new Error("Expected the first completed tool call before release");
      }
      for (let index = 0; index < extraCompletedCalls; index += 1) {
        sendToPage?.(
          cloneToolCallWithId(
            firstCompletedMessage as WebSocketMessage,
            `${firstCallId}:${index}`,
            index + 1,
          ),
        );
      }
      sequenceOffset = extraCompletedCalls;
      for (const message of heldMessages.splice(0)) {
        sendToPage?.(shiftTimelineSequence(message, sequenceOffset));
      }
    },
  };
}

async function configureOverviewToolCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ toolCallDetailLevel: "overview" }),
    );
  });
}

async function createOverviewAgent(page: Page, title: string) {
  await configureOverviewToolCalls(page);
  return seedMockAgentWorkspace({
    repoPrefix: "tool-call-overview-sheet-",
    title,
    model: "ten-second-stream",
  });
}

async function openOverviewAgent(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
): Promise<void> {
  await openAgentRoute(page, {
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
  });
  await expectComposerVisible(page);
}

function hasScrolledToLatest(root: HTMLElement): boolean {
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    if (node.scrollHeight <= node.clientHeight) {
      continue;
    }
    const maximumScrollTop = node.scrollHeight - node.clientHeight;
    return maximumScrollTop > 0 && Math.abs(node.scrollTop - maximumScrollTop) <= 1;
  }
  return false;
}

function readScrollMetrics(root: HTMLElement) {
  const badgeElements = root.querySelectorAll<HTMLElement>("[data-testid=tool-call-badge]");
  const latestBadge = badgeElements.item(badgeElements.length - 1);
  const scrollables = [];
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    if (node.scrollHeight <= node.clientHeight) {
      continue;
    }
    scrollables.push({
      className: node.className,
      clientHeight: node.clientHeight,
      rect: node.getBoundingClientRect().toJSON(),
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      tagName: node.tagName,
    });
  }
  return {
    latestBadgeRect: latestBadge?.getBoundingClientRect().toJSON(),
    rootRect: root.getBoundingClientRect().toJSON(),
    scrollables,
    viewport: { height: window.innerHeight, width: window.innerWidth },
  };
}

test.describe("compact overview tool calls", () => {
  test.use({ viewport: COMPACT_VIEWPORT, hasTouch: true });

  test("keeps a live group sheet current and stacks individual details above it", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const agent = await createOverviewAgent(page, "Compact overview tool calls");

    try {
      const gate = await holdStreamAfterFirstCompletedToolCall(page, agent.agentId);
      await openOverviewAgent(page, agent);
      await agent.client.sendAgentMessage(agent.agentId, "Exercise the overview tool-call sheet.");
      await gate.waitForFirstCompleted();

      const group = page.getByTestId("tool-call-group").first();
      await expect(group).toBeVisible();
      await group.click();

      const sheet = page.getByTestId("tool-call-group-sheet");
      const summary = page.getByTestId("tool-call-group-sheet-summary");
      await expect(sheet).toBeVisible();
      const initialSummary = await summary.innerText();

      gate.release(10);
      const badges = sheet.getByTestId("tool-call-badge");
      await expect.poll(() => badges.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(11);
      await expect(summary).not.toHaveText(initialSummary);
      await expect.poll(() => sheet.evaluate(hasScrolledToLatest)).toBe(true);
      const scrollMetrics = await sheet.evaluate(readScrollMetrics);
      await testInfo.attach("compact-overview-scroll-metrics", {
        body: JSON.stringify(scrollMetrics, null, 2),
        contentType: "application/json",
      });

      await badges.last().click();
      const detailClose = page.getByTestId("tool-call-sheet-close");
      await expect(detailClose).toBeVisible();

      await detailClose.click();
      await expect(detailClose).toBeHidden();
      await expect(sheet).toBeVisible();

      await testInfo.attach("compact-overview-tool-call-group", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.getByTestId("tool-call-group-sheet-close").click();
      await expect(sheet).toBeHidden();
      await expect(group).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });
});

test("keeps overview tool calls inline on desktop", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await createOverviewAgent(page, "Desktop overview tool calls");

  try {
    await openOverviewAgent(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Exercise desktop overview tool calls.");
    const group = page.getByTestId("tool-call-group").first();
    await expect(group).toBeVisible();

    await group.click();
    await expect(page.getByTestId("tool-call-group-sheet")).toHaveCount(0);
    await expect(group.getByTestId("tool-call-badge").first()).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

const SHELL_LONG_TOKEN = "0123456789abcdef".repeat(12);
const SHELL_COMMAND = [
  'for file in "src/a.ts" "src/b.ts"; do',
  '  printf "%s\\n" "$file"',
  `  echo "${SHELL_LONG_TOKEN}"`,
  "done",
].join("\n");
const SHELL_OUTPUT = [
  "src/a.ts",
  "  indentation stays intact",
  SHELL_LONG_TOKEN,
  'plain output: { "if": true, "value": "$file" }',
  "last output line",
].join("\n");
const SHELL_TEXT = `$ ${SHELL_COMMAND}\n\n${SHELL_OUTPUT}`;
const EDIT_OLD = ["export function example() {", '  return "before";', "}"].join("\n");
const EDIT_NEW = [
  "export function example() {",
  `  const token = "${SHELL_LONG_TOKEN}";`,
  '  return token + "after";',
  "}",
].join("\n");
const EDIT_LINES = [
  " export function example() {",
  '-  return "before";',
  `+  const token = "${SHELL_LONG_TOKEN}";`,
  '+  return token + "after";',
  " }",
];

async function measureSheetMotion(element: Element): Promise<number> {
  const positions = [];
  for (let frame = 0; frame < 6; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    positions.push(element.getBoundingClientRect().top);
  }
  return Math.max(...positions) - Math.min(...positions);
}

async function expandToolDetailSheet(
  page: Page,
  testInfo: TestInfo,
  artifact: string,
): Promise<void> {
  const close = page.getByTestId("tool-call-sheet-close");
  await expect(close).toBeVisible();
  await expect.poll(() => close.evaluate(measureSheetMotion)).toBeLessThanOrEqual(0.25);
  await captureShellDetails(page, testInfo, `${artifact}-default-snap`);
  await testInfo.attach(`${artifact}-default-snap-geometry`, {
    body: JSON.stringify({ close: await close.boundingBox(), viewport: page.viewportSize() }),
    contentType: "application/json",
  });
  const handle = page.getByRole("slider", { name: "Bottom sheet handle", exact: true });
  await expect(handle).toBeVisible();
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Expected the tool detail sheet handle to be rendered");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, 40, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(
      async () => (await page.getByTestId("tool-call-sheet-close").boundingBox())?.y ?? Infinity,
    )
    .toBeLessThan(250);
  await expect.poll(() => close.evaluate(measureSheetMotion)).toBeLessThanOrEqual(0.25);
}

async function expectCodeVisibleVertically(content: Locator): Promise<void> {
  await expect
    .poll(() =>
      content.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = [...range.getClientRects()];
        return rects.every((rect) => rect.top >= 0 && rect.bottom <= window.innerHeight);
      }),
    )
    .toBe(true);
}

async function captureShellDetails(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function expectShellTextFits(text: Locator): Promise<void> {
  // Inspect the rendered glyphs as well as the box: hiding horizontal overflow
  // must not satisfy a wrapping regression test by clipping the long token.
  await expect
    .poll(() =>
      text.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let overflow = Math.max(0, -bounds.left, bounds.right - window.innerWidth);
        let node = walker.nextNode();
        while (node) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            overflow = Math.max(overflow, bounds.left - rect.left, rect.right - bounds.right);
          }
          node = walker.nextNode();
        }
        return Math.max(overflow, element.scrollWidth - element.clientWidth);
      }),
    )
    .toBeLessThanOrEqual(1);
}

async function expectShellColors(text: Locator): Promise<void> {
  const colors = await text.evaluate((element, commandLength) => {
    const commandColors = new Set<string>();
    const outputColors = new Set<string>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      const color = getComputedStyle(node.parentElement!).color;
      if (offset < commandLength && offset + length > 2) commandColors.add(color);
      if (offset + length > commandLength + 2) outputColors.add(color);
      offset += length;
      node = walker.nextNode();
    }
    return { command: [...commandColors], output: [...outputColors] };
  }, SHELL_COMMAND.length + 2);
  expect(colors.command.length).toBeGreaterThanOrEqual(3);
  expect(colors.output).toHaveLength(1);
}

async function readCodeColors(content: Locator): Promise<string[]> {
  return content.evaluate((element) => {
    const colors = new Set<string>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.trim()) colors.add(getComputedStyle(node.parentElement!).color);
      node = walker.nextNode();
    }
    return [...colors].sort();
  });
}

async function copyToolText(page: Page, text: Locator, expectedText: string): Promise<void> {
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedText);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

async function expectShellScrollsHorizontally(page: Page, scroll: Locator): Promise<void> {
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(200);
  await scroll.hover();
  await page.mouse.wheel(400, 0);
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
}

async function toggleWrapWithKeyboard(
  page: Page,
  toggle: Locator,
  content: Locator,
): Promise<void> {
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expectShellTextFits(content);
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
}

async function expectCompactWrapHeader({
  page,
  accessibleName = "Wrap long lines",
}: {
  page: Page;
  accessibleName?: string;
}): Promise<void> {
  const toggle = page.getByTestId("tool-detail-wrap-toggle");
  const title = page.getByTestId("tool-call-sheet-title");
  const close = page.getByTestId("tool-call-sheet-close");
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveRole("button");
  await expect(toggle).toHaveAccessibleName(accessibleName);
  await expect(toggle).toHaveText("");
  await expect(toggle.locator("svg")).toBeVisible();
  await expect(title).toBeVisible();
  await expect
    .poll(async () => {
      const [toggleBox, titleBox, closeBox] = await Promise.all([
        toggle.boundingBox(),
        title.boundingBox(),
        close.boundingBox(),
      ]);
      if (!toggleBox || !titleBox || !closeBox) return false;
      const toggleCenter = toggleBox.y + toggleBox.height / 2;
      return (
        toggleBox.width >= 44 &&
        toggleBox.height >= 44 &&
        toggleBox.x >= titleBox.x + titleBox.width - 1 &&
        toggleBox.x + toggleBox.width <= closeBox.x + 1 &&
        closeBox.x + closeBox.width <= (page.viewportSize()?.width ?? 0) &&
        Math.abs(toggleCenter - (titleBox.y + titleBox.height / 2)) <= 1 &&
        Math.abs(toggleCenter - (closeBox.y + closeBox.height / 2)) <= 1
      );
    })
    .toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  for (const formFactor of ["compact", "desktop"] as const) {
    test.describe(`shell tool details ${formFactor} ${theme}`, () => {
      const compact = formFactor === "compact";
      test.use({
        viewport: compact ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        hasTouch: compact,
      });

      test("highlights commands, wraps long lines, and preserves selectable output", async ({
        context,
        page,
      }, testInfo) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem(
            "@paseo:app-settings",
            JSON.stringify({ theme: selectedTheme, toolCallDetailLevel: "detailed" }),
          );
        }, theme);
        const agent = await seedMockAgentWorkspace({
          repoPrefix: "shell-tool-call-details-",
          title: "Shell display regression",
          initialPrompt: "Show the configured shell command and output.",
          featureValues: {
            mockToolCallDetail: {
              type: "shell",
              command: `${SHELL_COMMAND}\n\n`,
              output: `\n\n${SHELL_OUTPUT}`,
            },
          },
        });

        try {
          await agent.client.waitForFinish(agent.agentId, 30_000);
          await openAgentRoute(page, agent);
          const badge = page.getByTestId("tool-call-badge").filter({ hasText: "Shell" });
          await expect(badge).toBeVisible();
          await badge.getByRole("button").first().click();
          if (compact) await expandToolDetailSheet(page, testInfo, `shell-${formFactor}-${theme}`);

          const text = page.getByText(SHELL_TEXT, { exact: true });
          const toggle = page.getByTestId("tool-detail-wrap-toggle");
          const horizontalScroll = page.getByTestId("shell-detail-horizontal-scroll");
          await expect(text).toBeVisible();
          await expect.poll(() => text.textContent()).toBe(SHELL_TEXT);
          await captureShellDetails(page, testInfo, `shell-${formFactor}-${theme}-initial`);
          if (compact) {
            await expectCompactWrapHeader({ page });
            await expectShellTextFits(text);
            await expectCodeVisibleVertically(text);
          } else {
            await expect(toggle).toHaveText("Wrap long lines");
            await expect(toggle).toHaveAccessibleName("Wrap long lines");
          }
          await expect(toggle).toHaveRole("button");
          await expect(toggle).toHaveAttribute("aria-pressed", String(compact));
          await expectShellColors(text);
          if (!compact) await toggleWrapWithKeyboard(page, toggle, text);
          const routeBeforeClose = page.url();

          if (compact) {
            await expectShellTextFits(text);
            await expect(horizontalScroll).toHaveCount(0);
            await captureShellDetails(page, testInfo, `${formFactor}-${theme}-wrapped-default`);
            await copyToolText(page, text, SHELL_TEXT);
            await toggle.click();
          }

          await expect(toggle).toHaveAttribute("aria-pressed", "false");
          await expect(horizontalScroll).toBeVisible();
          await captureShellDetails(page, testInfo, `${formFactor}-${theme}-unwrapped`);
          await expectShellScrollsHorizontally(page, horizontalScroll);
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-pressed", "true");
          await expectShellTextFits(text);
          await expect(horizontalScroll).toHaveCount(0);
          await copyToolText(page, text, SHELL_TEXT);
          await captureShellDetails(page, testInfo, `${formFactor}-${theme}-wrapped`);

          if (compact) {
            await page.getByTestId("tool-call-sheet-close").click();
          } else {
            await badge.getByRole("button").first().click();
          }
          await expect(text).toBeHidden();
          await expect(page).toHaveURL(routeBeforeClose);
          await expectComposerVisible(page);
          await badge.getByRole("button").first().click();
          await expect(text).toBeVisible();
          await expect.poll(() => text.textContent()).toBe(SHELL_TEXT);
          await expect(toggle).toHaveAttribute("aria-pressed", String(compact));
          await expectShellColors(text);
        } finally {
          await agent.cleanup();
        }
      });

      test("wraps highlighted edit diffs without losing signs, indentation, or copy", async ({
        context,
        page,
      }, testInfo) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem(
            "@paseo:app-settings",
            JSON.stringify({ theme: selectedTheme, toolCallDetailLevel: "detailed" }),
          );
        }, theme);
        const agent = await seedMockAgentWorkspace({
          repoPrefix: "edit-tool-call-details-",
          title: "Edit display regression",
          initialPrompt: "Show the configured edit.",
          featureValues: {
            mockToolCallDetail: {
              type: "edit",
              filePath: "src/example.ts",
              oldString: EDIT_OLD,
              newString: EDIT_NEW,
            },
          },
        });

        try {
          await agent.client.waitForFinish(agent.agentId, 30_000);
          await openAgentRoute(page, agent);
          const badge = page.getByTestId("tool-call-badge").filter({ hasText: "Edit" });
          await expect(badge).toBeVisible();
          await badge.getByRole("button").first().click();
          if (compact) await expandToolDetailSheet(page, testInfo, `edit-${formFactor}-${theme}`);
          const content = page.locator("[data-pmono]").filter({ hasText: EDIT_LINES[2] });
          const toggle = page.getByTestId("tool-detail-wrap-toggle");
          const horizontalScroll = page.getByTestId("diff-viewer-horizontal-scroll");
          await expect(content).toBeVisible();
          await expect
            .poll(() => content.locator(":scope > div").allTextContents())
            .toEqual(EDIT_LINES);
          await captureShellDetails(page, testInfo, `edit-${formFactor}-${theme}-initial`);
          if (compact) {
            await expectCompactWrapHeader({ page });
            await expectShellTextFits(content);
            await expectCodeVisibleVertically(content);
          } else {
            await expect(toggle).toHaveText("Wrap long lines");
            await expect(toggle).toHaveAccessibleName("Wrap long lines");
          }
          await expect(toggle).toHaveAttribute("aria-pressed", String(compact));
          const initialColors = await readCodeColors(content);
          expect(initialColors.length).toBeGreaterThanOrEqual(3);
          if (!compact) await toggleWrapWithKeyboard(page, toggle, content);

          if (compact) {
            await expectShellTextFits(content);
            await expect(horizontalScroll).toHaveCount(0);
            await captureShellDetails(
              page,
              testInfo,
              `edit-${formFactor}-${theme}-wrapped-default`,
            );
            await toggle.click();
          }

          await expect(horizontalScroll).toBeVisible();
          await captureShellDetails(page, testInfo, `edit-${formFactor}-${theme}-unwrapped`);
          await expectShellScrollsHorizontally(page, horizontalScroll);
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-pressed", "true");
          await expect(horizontalScroll).toHaveCount(0);
          await expectShellTextFits(content);
          expect(await readCodeColors(content)).toEqual(initialColors);
          await copyToolText(page, content, EDIT_LINES.join("\n"));
          await captureShellDetails(page, testInfo, `edit-${formFactor}-${theme}-wrapped`);

          const routeBeforeClose = page.url();
          if (compact) {
            await page.getByTestId("tool-call-sheet-close").click();
          } else {
            await badge.getByRole("button").first().click();
          }
          await expect(content).toBeHidden();
          await expect(page).toHaveURL(routeBeforeClose);
          await expectComposerVisible(page);
          await badge.getByRole("button").first().click();
          await expect(content).toBeVisible();
          await expect
            .poll(() => content.locator(":scope > div").allTextContents())
            .toEqual(EDIT_LINES);
          await expect(toggle).toHaveAttribute("aria-pressed", String(compact));
        } finally {
          await agent.cleanup();
        }
      });
    });
  }
}

test.describe("localized tool detail controls", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("keeps the French icon-only wrap control accessible in the larger header", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ language: "fr", theme: "light", uiBaseFontSize: 20 }),
      );
    });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "localized-tool-detail-",
      title: "Localized tool detail",
      initialPrompt: "Show the configured shell command and output.",
      featureValues: {
        mockToolCallDetail: { type: "shell", command: SHELL_COMMAND, output: SHELL_OUTPUT },
      },
    });

    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, agent);
      await page.getByTestId("tool-call-badge").getByRole("button").first().click();
      await expandToolDetailSheet(page, testInfo, "compact-french");
      const toggle = page.getByTestId("tool-detail-wrap-toggle");
      await expectCompactWrapHeader({
        page,
        accessibleName: "Renvoyer les longues lignes à la ligne",
      });
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await captureShellDetails(page, testInfo, "compact-french-large-interface");
      await expectShellTextFits(toggle);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    } finally {
      await agent.cleanup();
    }
  });
});
