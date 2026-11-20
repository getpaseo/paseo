import { expect, test } from "../support/fixtures";
import {
  chatOutlineRail,
  disableChatOutline,
  expectChatOutlinePrompts,
  expectNoChatOutline,
} from "../support/helpers/chat-outline";
import {
  chooseContentWidth,
  expectColumnAtLeftGutter,
  expectColumnClearOfOutline,
  expectContentColumnWidth,
} from "../support/helpers/content-width";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const ULTRAWIDE_VIEWPORT = { width: 2560, height: 1080 };
const DEFAULT_COLUMN = { min: 800, max: 820 };
const WIDE_COLUMN = { min: 1180, max: 1200 };
const FULL_COLUMN = { min: 2000, max: ULTRAWIDE_VIEWPORT.width };

test("resizes mounted chat content and leaves room for the outline at full width", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "content-width-",
    title: "Content width",
    initialPrompt: "Write a long paragraph.",
  });

  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await agent.client.sendAgentMessage(agent.agentId, "Write another paragraph.");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await page.setViewportSize(ULTRAWIDE_VIEWPORT);
    await openAgentRoute(page, agent);
    await expectChatOutlinePrompts(page, 2);
    const reply = page.getByTestId("assistant-message").first();
    const composer = page.getByTestId("message-input-root");
    await expectContentColumnWidth(reply, DEFAULT_COLUMN);
    const originalReply = await reply.elementHandle();

    await chooseContentWidth(page, "Wide");
    await expectContentColumnWidth(reply, WIDE_COLUMN);
    await expectContentColumnWidth(composer, WIDE_COLUMN);

    await chooseContentWidth(page, "Full");
    await expectContentColumnWidth(reply, FULL_COLUMN);
    await expectContentColumnWidth(composer, FULL_COLUMN);
    await expectColumnClearOfOutline(reply, chatOutlineRail(page));

    await disableChatOutline(page);
    await expectNoChatOutline(page);
    await expectColumnAtLeftGutter(page, reply);

    await chooseContentWidth(page, "Default");
    await expectContentColumnWidth(reply, DEFAULT_COLUMN);
    await expectContentColumnWidth(composer, DEFAULT_COLUMN);
    expect(await originalReply?.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await agent.cleanup();
  }
});

test("updates an open Markdown preview when the content width changes", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "markdown-content-width-",
    title: "Markdown content width",
  });

  try {
    await page.setViewportSize(ULTRAWIDE_VIEWPORT);
    await openAgentRoute(page, agent);
    await openFileExplorer(page);
    await openFileFromExplorer(page, "README.md");
    const preview = page.getByTestId("markdown-preview-frame").first();
    await expectContentColumnWidth(preview, DEFAULT_COLUMN);

    await chooseContentWidth(page, "Wide");
    await expectContentColumnWidth(preview, WIDE_COLUMN);

    await chooseContentWidth(page, "Full");
    await expectContentColumnWidth(preview, { min: 1500, max: ULTRAWIDE_VIEWPORT.width });
  } finally {
    await agent.cleanup();
  }
});
