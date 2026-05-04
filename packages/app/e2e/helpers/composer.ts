import { expect, type Page } from "@playwright/test";

function composerInput(page: Page) {
  return page.getByRole("textbox", { name: "Message agent..." }).first();
}

export async function submitMessage(page: Page, text: string): Promise<void> {
  const input = composerInput(page);
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(text);
  await input.press("Enter");
}

export async function cancelAgent(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: /stop|cancel/i }).first();
  await expect(stopButton).toBeVisible({ timeout: 10_000 });
  await stopButton.click();
}
