import { expect, type Page } from "@playwright/test";
import { buildAgentRoute, seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";

interface LongTimelineAgentOptions {
  turns: number;
}

interface LongTimelineAgent extends MockAgentWorkspace {
  oldestPrompt: string;
  newestPrompt: string;
}

const PROMPT_PREFIX = "timeline-pagination-turn";

function promptForTurn(index: number): string {
  return `${PROMPT_PREFIX}-${index}: emit 1 coalesced agent stream updates`;
}

export async function seedLongMockAgentTimeline(
  options: LongTimelineAgentOptions,
): Promise<LongTimelineAgent> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "timeline-pagination-",
    title: "Timeline pagination regression",
    model: "ten-second-stream",
  });

  for (let index = 0; index < options.turns; index += 1) {
    await agent.client.sendAgentMessage(agent.agentId, promptForTurn(index));
    await agent.client.waitForFinish(agent.agentId, 15_000);
  }

  return {
    ...agent,
    oldestPrompt: promptForTurn(0),
    newestPrompt: promptForTurn(options.turns - 1),
  };
}

export async function openAgentTimeline(page: Page, agent: LongTimelineAgent): Promise<void> {
  await page.goto(buildAgentRoute(agent.cwd, agent.agentId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
}

export async function expectTimelinePromptVisible(page: Page, prompt: string): Promise<void> {
  await expect(page.getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 });
}

export async function expectTimelinePromptNotMounted(page: Page, prompt: string): Promise<void> {
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(0);
}

export async function scrollTimelineToOldestLoadedEdge(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.hover();
  await page.mouse.wheel(0, -20_000);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await scroll.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Agent chat scroll element is not an HTMLElement");
    }
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

export async function scrollTimelineUntilOlderHistoryIsReachable(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const previousHeight = await scroll.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Agent chat scroll element is not an HTMLElement");
    }
    return element.scrollHeight;
  });

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await scrollTimelineToOldestLoadedEdge(page);
  await expect
    .poll(async () =>
      scroll.evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          throw new Error("Agent chat scroll element is not an HTMLElement");
        }
        return element.scrollHeight;
      }),
    )
    .toBeGreaterThan(previousHeight);
  await scrollTimelineToOldestLoadedEdge(page);
}
