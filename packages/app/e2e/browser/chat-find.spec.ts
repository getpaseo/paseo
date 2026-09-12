import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  expectReconnectingToastGone,
  expectReconnectingToastVisible,
} from "../support/helpers/workspace-ui";
import { trackPromptJumpRequests } from "../support/helpers/agent-timeline-gate";

const RESPONSE =
  'İ😀hello **world**; hello *world*.\n\n[hello &amp; world](https://example.com/hidden-destination)\n\n```ts\nconst a = "a.b";\n```\n\n- first cell\n- second cell';

function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}
function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}
async function searchChat(page: Page, text: string) {
  await page.getByTestId("assistant-message").filter({ visible: true }).last().click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  await query(page).fill(text);
}
async function expectHighlight(page: Page, text: string) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entries = Array.from(CSS.highlights.entries()).filter(([name]) =>
          name.startsWith("paseo-chat-find-"),
        );
        const texts: string[] = [];
        for (const [, highlight] of entries) {
          for (const range of highlight) texts.push(range.toString());
        }
        return texts;
      }),
    )
    .toEqual([text]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entry = Array.from(CSS.highlights.entries()).find(([name]) =>
          name.startsWith("paseo-chat-find-"),
        );
        const range = entry && Array.from(entry[1])[0];
        if (!(range instanceof Range)) return false;
        const rect = range.getBoundingClientRect();
        const row = range.startContainer.parentElement?.closest(
          '[data-testid="agent-chat-scroll"]',
        );
        const viewport = row?.getBoundingClientRect();
        return (
          !!viewport && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
        );
      }),
    )
    .toBe(true);
}
async function nextMatch(page: Page) {
  await query(page).press("Enter");
}
async function previousMatch(page: Page) {
  await query(page).press("Shift+Enter");
}
async function closeFind(page: Page) {
  await query(page).press("Escape");
  await expect(query(page)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(CSS.highlights.keys()).filter((key) => key.startsWith("paseo-chat-find-")),
      ),
    )
    .toEqual([]);
}

test("loads older history through prompt navigation and finds repeated rendered Markdown", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-",
    title: "Chat Find",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    for (let index = 0; index < 45; index++) {
      await agent.client.sendAgentMessage(agent.agentId, `Prompt number ${index}`);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    const jumps = await trackPromptJumpRequests(page, agent.agentId);
    await openAgentRoute(page, agent);
    await expect(page.getByText("Prompt number 44", { exact: true })).toBeVisible();
    await expect(page.getByText("Prompt number 0", { exact: true })).toHaveCount(0);
    await searchChat(page, "hello world");
    await expectHighlight(page, "hello world");
    await expect(status(page)).toHaveText("1 of 2 in message");
    await page.screenshot({ path: testInfo.outputPath("chat-find-highlight.png") });
    expect(jumps.requests()[0]).toMatchObject({ limit: 40, mergeWindow: true });
    await nextMatch(page);
    await expect(status(page)).toHaveText("2 of 2 in message");
    await expectHighlight(page, "hello world");
    await previousMatch(page);
    await expect(status(page)).toHaveText("1 of 2 in message");
    await query(page).fill("hello & world");
    await expectHighlight(page, "hello & world");
    await query(page).fill("a.b");
    await expectHighlight(page, "a.b");
    await query(page).fill("Prompt number 0");
    await expectHighlight(page, "Prompt number 0");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

test("rejects invisible source matches and ignores a late reply after closing", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-cancel-",
    title: "Chat Find cancellation",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const gate = await installDaemonWebSocketGate(page);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    await searchChat(page, "hidden-destination");
    await expect(status(page)).toHaveText("No matches");
    await query(page).fill("first cell second cell");
    await expect(status(page)).toHaveText("No matches");
    gate.holdNextServerMessage("agent.timeline.search.response");
    await query(page).fill("hello world");
    await expect(status(page)).toHaveText("Searching…");
    await gate.waitForHeldServerMessage("agent.timeline.search.response");
    await closeFind(page);
    gate.releaseHeldServerMessage("agent.timeline.search.response");
    await searchChat(page, "a.b");
    await expectHighlight(page, "a.b");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

test("shows a disconnected search failure and recovers with Retry", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-retry-",
    title: "Chat Find retry",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const gate = await installDaemonWebSocketGate(page);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    await gate.drop();
    await expectReconnectingToastVisible(page);
    await searchChat(page, "hello world");
    await expect(status(page)).toHaveText("Failed");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    gate.restore();
    await expectReconnectingToastGone(page);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expectHighlight(page, "hello world");
  } finally {
    await agent.cleanup();
  }
});

test("finds text beyond the normal render cap and restores the cap when Find closes", async ({
  page,
}) => {
  const tail = "oversized-tail-needle";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-cap-",
    title: "Chat Find long message",
    initialPrompt: "Render a long response",
    featureValues: { mockAssistantResponse: `${"background ".repeat(3100)}\n\n${tail}` },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    const message = page.getByTestId("assistant-message");
    await expect(message).toBeVisible();
    await expect(message).not.toContainText(tail);
    await searchChat(page, tail);
    await expectHighlight(page, tail);
    await closeFind(page);
    await expect(message).not.toContainText(tail);
    await expect(message.getByTestId("assistant-message-capped-notice")).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});
