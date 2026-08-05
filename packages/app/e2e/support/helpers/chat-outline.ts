import { expect, type Locator, type Page } from "@playwright/test";
import { openSettings } from "./app";
import { openSettingsSection } from "./settings";

export function chatOutlineRail(page: Page): Locator {
  return page.getByTestId("chat-outline-rail");
}

function chatOutlinePrompt(page: Page, position: number): Locator {
  return chatOutlineRail(page)
    .getByRole("tab")
    .nth(position - 1);
}

export async function expectChatOutlinePrompts(page: Page, count: number): Promise<void> {
  await expect(chatOutlineRail(page)).toBeVisible();
  await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(count);
}

export async function expectNoChatOutline(page: Page): Promise<void> {
  await expect(chatOutlineRail(page)).toBeHidden();
}

export async function hoverChatOutlinePrompt(page: Page, position: number): Promise<void> {
  await chatOutlinePrompt(page, position).hover();
}

/**
 * The trailing edge of a prompt's row, far from its left-anchored pill. Acquiring a prompt
 * there is what makes the rail usable when a long conversation squeezes the pills thin.
 */
export async function pointAtChatOutlineRowEdge(page: Page, position: number): Promise<void> {
  const row = await promptRowBox(page, position);
  await page.mouse.move(row.x + row.width - 1, row.y + row.height / 2);
}

export async function clickChatOutlineRowEdge(page: Page, position: number): Promise<void> {
  await pointAtChatOutlineRowEdge(page, position);
  await page.mouse.down();
  await page.mouse.up();
}

export async function splitCurrentPanelRight(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Split pane right" }).first().click();
}

export async function disableChatOutlineFromAppearance(page: Page): Promise<void> {
  const timelineUrl = page.url();
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  await page.getByRole("switch", { name: "Chat outline" }).click();
  await page.goto(timelineUrl);
}

/** Parks the pointer in the middle of the transcript, clear of the rail. */
export async function movePointerOffChatOutline(page: Page): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const box = await requireBoundingBox(timeline);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

export async function focusChatOutlinePrompt(page: Page, position: number): Promise<void> {
  await chatOutlinePrompt(page, position).focus();
}

export async function pressEnterOnFocusedPrompt(page: Page): Promise<void> {
  await page.keyboard.press("Enter");
}

export async function expectChatOutlinePreview(page: Page, preview: string): Promise<void> {
  await expect(page.getByTestId("chat-outline-preview")).toHaveText(preview);
}

export async function expectNoChatOutlinePreview(page: Page): Promise<void> {
  await expect(page.getByTestId("chat-outline-preview")).toHaveCount(0);
}

export async function expectNoChatOutlinePreviewWhileCrossingToSidebar(page: Page): Promise<void> {
  const railBox = await requireBoundingBox(chatOutlineRail(page));
  await page.mouse.move(railBox.x + railBox.width + 2, railBox.y + railBox.height / 2);
  await page.evaluate(() => {
    document.body.dataset.chatOutlinePreviewObserved = String(
      document.querySelector('[data-testid="chat-outline-preview"]') !== null,
    );
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="chat-outline-preview"]')) {
        document.body.dataset.chatOutlinePreviewObserved = "true";
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Object.assign(window, { __chatOutlinePreviewObserver: observer });
  });

  for (let step = 0; step <= 10; step += 1) {
    await page.mouse.move(
      railBox.x + railBox.width - 1 - (step * railBox.width) / 10,
      railBox.y + railBox.height / 2,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }
  await page.mouse.move(railBox.x - 2, railBox.y + railBox.height / 2);

  const previewAppeared = await page.evaluate(() => {
    const observer = Reflect.get(window, "__chatOutlinePreviewObserver") as
      | MutationObserver
      | undefined;
    observer?.disconnect();
    Reflect.deleteProperty(window, "__chatOutlinePreviewObserver");
    const observed = document.body.dataset.chatOutlinePreviewObserved === "true";
    delete document.body.dataset.chatOutlinePreviewObserved;
    return observed;
  });
  expect(previewAppeared).toBe(false);
}

export async function expectChatOutlinePromptToRemainBare(
  page: Page,
  position: number,
): Promise<void> {
  await expect(chatOutlinePrompt(page, position)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

/** Exactly one prompt is marked, without saying which — the reader always has a "you are here". */
export async function expectOneActiveChatOutlinePrompt(page: Page): Promise<void> {
  await expect(chatOutlineRail(page).getByRole("tab", { selected: true })).toHaveCount(1);
}

export async function expectActiveChatOutlinePrompt(page: Page, position: number): Promise<void> {
  await expect(chatOutlineRail(page).getByRole("tab", { selected: true })).toHaveAccessibleName(
    new RegExp(`^${position} of `),
  );
}

export async function expectLiveTurnPromptAboveFoldAndActive(
  page: Page,
  prompt: string,
  position: number,
): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const promptRow = timeline.getByTestId("user-message").filter({ hasText: prompt });
  const activeTick = chatOutlineRail(page).getByRole("tab", { selected: true });
  await expect
    .poll(
      async () => {
        const [timelineBox, promptBox, activeLabel] = await Promise.all([
          timeline.boundingBox(),
          promptRow.boundingBox(),
          activeTick.getAttribute("aria-label"),
        ]);
        return Boolean(
          timelineBox &&
          promptBox &&
          promptBox.y + promptBox.height < timelineBox.y &&
          activeLabel?.startsWith(`${position} of `),
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function promptRowBox(
  page: Page,
  position: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return requireBoundingBox(chatOutlinePrompt(page, position));
}

async function requireBoundingBox(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected the chat outline element to have a layout box");
  }
  return box;
}
