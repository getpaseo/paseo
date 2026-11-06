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
  const attachment = page.getByTestId(testId).filter({ visible: true }).last();
  await expect(attachment).toBeVisible({ timeout: 10_000 });
  await attachment.click();
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

export async function rewindForkPrompt(page: Page) {
  const prompt = page.getByTestId("user-message").filter({ visible: true }).last();
  await prompt.hover();
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
