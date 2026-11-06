import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { MockAgentWorkspace } from "./mock-agent";
import { getServerId } from "./server-id";

export function setChatHistoryViewport(page: Page, layout: "wide" | "compact") {
  return page.setViewportSize(
    layout === "wide" ? { width: 1280, height: 720 } : { width: 390, height: 844 },
  );
}

export async function expectInlineChatHistory(page: Page, contents: string[]) {
  const history = page.getByTestId("chat-history-transcript").filter({ visible: true });
  await expectHistoryContents(page, history, contents);
}

async function expectHistoryContents(page: Page, history: Locator, contents: string[]) {
  await expect(history).toBeVisible({ timeout: 30_000 });
  for (const text of contents) {
    await expect(history).toContainText(text);
  }
  await expect(history.getByText("Conversation continues here", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chat-history-preview")).toHaveCount(0);
}

export async function expectResentChatHistory(page: Page, contents: string[]) {
  const histories = page.getByTestId("chat-history-transcript").filter({ visible: true });
  // The mock provider deliberately retains the first user prompt on rewind.
  // Require a second snapshot so the retained original cannot satisfy this check.
  await expect(histories).toHaveCount(2);
  await expectHistoryContents(page, histories.last(), contents);
}

export async function expectChatHistoryMessageStyles(page: Page, userText: string) {
  const history = page.getByTestId("chat-history-transcript").filter({ visible: true });
  await expect(history.getByTestId("user-message")).toContainText(userText);
  await expect(history.getByTestId("assistant-message")).toContainText("const answer = 42;");
  await expect(history.getByRole("heading", { name: "The answer" })).toBeVisible();
  await expect(history.getByTestId("user-message-timestamp")).toHaveCount(0);
}

export async function followChatHistorySource(page: Page) {
  await page
    .getByTestId("chat-history-transcript")
    .getByRole("button", { name: "Open source chat" })
    .click();
}

export async function captureChatHistory(page: Page, testInfo: TestInfo, name: string) {
  // Follow the existing QA helpers: settle spring animations and hide Expo-only chrome.
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: testInfo.outputPath(name), animations: "disabled" });
}

export async function sendChatHistoryFromAnotherClient(
  session: MockAgentWorkspace,
  history: string,
) {
  const serverId = getServerId();
  await session.client.sendAgentMessage(session.agentId, "", {
    attachments: [
      {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        text: history,
        chatHistorySource: { serverId, agentId: "source-agent", title: "Original conversation" },
      },
    ],
  });
}

export async function expectSavedAnswerEnding(page: Page, ending: string) {
  const history = page.getByTestId("chat-history-transcript").filter({ visible: true });
  const finalParagraph = history
    .getByTestId("assistant-message")
    .getByText(ending, { exact: true });
  await expect(finalParagraph).toBeAttached({ timeout: 15_000 });
  await finalParagraph.scrollIntoViewIfNeeded();
  await expect(finalParagraph).toBeInViewport();
  await expect(history.getByTestId("assistant-message-capped-notice")).toHaveCount(0);
}

export async function openChatHistory(page: Page, location: "draft" | "sent", contents: string[]) {
  const testId =
    location === "draft"
      ? "composer-chat-history-attachment-pill"
      : "message-chat-history-attachment";
  const attachment = page.getByTestId(testId).filter({ visible: true }).last();
  await expect(attachment).toBeVisible({ timeout: 10_000 });
  await attachment.click();
  for (const text of contents) {
    await expect(page.getByTestId("chat-history-content")).toContainText(text);
  }
  await expect(
    page.getByTestId("chat-history-preview").getByRole("button", { name: "Open source chat" }),
  ).toBeVisible();
}

export async function closeChatHistory(page: Page) {
  await page
    .getByTestId("chat-history-preview")
    .getByRole("button", { name: "Close", exact: true })
    .click();
}

export async function rewindForkPrompt(page: Page) {
  const prompt = page.getByTestId("user-message").filter({ visible: true }).last();
  // Hover the content that owns hover state, not the full-width alignment row.
  await prompt.locator(":scope > div").hover();
  const trigger = prompt.getByRole("button", { name: "Rewind to this message", exact: true });
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const option = page.getByRole("menuitem", { name: "Rewind conversation", exact: true });
  await expect(option).toBeInViewport({ ratio: 1 });
  await option.click();
  await expect(option).not.toBeVisible();
}

export async function expectRewoundHistoryIsPrivate(page: Page, sourceId: string, forkId: string) {
  await page.getByTestId(`workspace-tab-agent_${sourceId}`).click();
  const history = page
    .getByTestId("composer-chat-history-attachment-pill")
    .filter({ visible: true });
  await expect(history).toHaveCount(0);
  await page.getByTestId(`workspace-tab-agent_${forkId}`).click();
  await expect(history).toBeVisible();
}

export async function expectNoDraftChatHistory(page: Page) {
  await expect(
    page.getByTestId("composer-chat-history-attachment-pill").filter({ visible: true }),
  ).toHaveCount(0);
}

export async function removeDraftChatHistory(page: Page) {
  await page.getByTestId("composer-chat-history-attachment-pill").filter({ visible: true }).hover();
  await page.getByRole("button", { name: "Remove chat history attachment", exact: true }).click();
  await expectNoDraftChatHistory(page);
}
