import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MARKER = "ChatCopyOnSelectMarker";

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

// Drags the mouse across the rendered text, like a user selecting it.
async function dragOverText(page: Page, text: string): Promise<void> {
  const box = await page
    .getByTestId("assistant-message")
    .getByText(text, { exact: true })
    .filter({ visible: true })
    .boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 1, y, { steps: 8 });
  await page.mouse.up();
}

test("copy on select copies a mouse selection in the chat", async ({ page, context }) => {
  // Read only: browsers deny clipboard-write by default, and the copy must work without it.
  await context.grantPermissions(["clipboard-read"]);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-copy-on-select-",
    title: "Chat copy on select",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: MARKER },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await page.goto(buildSettingsSectionRoute("chat"));
    const toggle = page.getByRole("switch", { name: "Copy on select" });
    await toggle.click();
    await expect(toggle).toBeChecked();

    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    expect(await readClipboard(page)).not.toBe(MARKER);

    await dragOverText(page, MARKER);

    await expect.poll(() => readClipboard(page)).toBe(MARKER);
  } finally {
    await agent.cleanup();
  }
});
