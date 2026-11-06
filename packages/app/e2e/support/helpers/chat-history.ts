import { expect, type Page, type TestInfo } from "@playwright/test";
import type { MockAgentWorkspace } from "./mock-agent";
import { getServerId } from "./server-id";

export function setChatHistoryViewport(page: Page, layout: "wide" | "compact") {
  return page.setViewportSize(
    layout === "wide" ? { width: 1280, height: 720 } : { width: 390, height: 844 },
  );
}

export async function openChatHistory(page: Page, location: "draft" | "sent", contents: string[]) {
  const testId =
    location === "draft"
      ? "composer-chat-history-attachment-pill"
      : "message-chat-history-attachment";
  await page.getByTestId(testId).click();
  for (const text of contents) {
    await expect(page.getByTestId("chat-history-content")).toContainText(text);
  }
  await expect(page.getByRole("button", { name: "Open source chat" })).toBeVisible();
}

export async function closeChatHistory(page: Page) {
  await page
    .getByTestId("chat-history-preview")
    .getByRole("button", { name: "Close", exact: true })
    .click();
}

export async function followChatHistorySource(page: Page) {
  await page.getByRole("button", { name: "Open source chat" }).click();
  await expect(page.getByTestId("chat-history-preview")).not.toBeVisible();
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
