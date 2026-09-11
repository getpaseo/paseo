import { expect, type Page } from "@playwright/test";
import type { MockAgentWorkspace } from "./mock-agent";

export async function requestStreamingMarkdown(agent: MockAgentWorkspace): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, "Show the formatted streaming response.");
}

export async function expectUnfinishedBold(page: Page): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  const bold = message.locator('[data-paseo-markdown-tag="strong"]');
  await expect(bold).toContainText("Bold");
  await expect(message).not.toContainText("stays bold");
  await expect(bold).toHaveCSS("font-weight", "500");
  await expect(message).not.toContainText("*");
}

export async function expectUnfinishedLink(page: Page): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  await expect(message).toContainText("Paseo docs");
  await expect(message.getByRole("link", { name: "Paseo docs" })).toHaveCount(0);
  await expect(message).not.toContainText("[");
  await expect(message).not.toContainText("https:");
}

export async function expectCompletedMarkdown(page: Page): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  await expect(message).toHaveText("Bold text stays bold and Paseo docs. Done.");
  await expect(
    message.getByRole("link", { name: "Paseo docs" }).and(message.locator("a")),
  ).toHaveAttribute("href", "https://example.com/documentation");
  await expect(message.locator('[data-paseo-markdown-tag="strong"]')).toHaveCSS(
    "font-weight",
    "500",
  );
}
