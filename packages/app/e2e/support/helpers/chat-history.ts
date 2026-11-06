import { expect, type Page, type TestInfo } from "@playwright/test";
import type { MockAgentWorkspace } from "./mock-agent";
import { getServerId } from "./server-id";

export function setChatHistoryViewport(page: Page, layout: "wide" | "compact") {
  return page.setViewportSize(
    layout === "wide" ? { width: 1280, height: 720 } : { width: 390, height: 844 },
  );
}

export async function expectInlineChatHistory(page: Page, contents: string[]) {
  const history = page.getByTestId("chat-history-transcript").filter({ visible: true });
  await expect(history).toBeVisible({ timeout: 30_000 });
  for (const text of contents) {
    await expect(history).toContainText(text);
  }
  await expect(history.getByText("Conversation continues here", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chat-history-preview")).toHaveCount(0);
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
