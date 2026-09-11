import { expect, test } from "../support/fixtures";
import { expectAgentReadyToInterrupt } from "../support/helpers/agent-stream";
import {
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { gotoAppShell, openSettings } from "../support/helpers/app";

test.describe("Composer queue modifier", () => {
  test("shows Queue and queues the click while Ctrl is held", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-queue-modifier-",
      title: "Composer queue modifier",
      model: "one-minute-stream",
    });
    const queuedPrompt = "Queue this message instead of steering the running turn.";

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, "Keep the agent running while the next message queues.");
      await expectAgentReadyToInterrupt(page);

      await fillComposerDraft(page, queuedPrompt);
      const sendButton = page.getByRole("button", { name: "Send and steer", exact: true });
      await expect(sendButton).toBeVisible();
      await expect(page.getByTestId("message-input-queue-icon")).toHaveCount(0);

      await page.keyboard.down("Control");
      await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeVisible();
      await expect(page.getByTestId("message-input-queue-icon")).toBeVisible();
      await page.getByRole("button", { name: "Queue message", exact: true }).hover();
      await expect(page.getByText("Queue", { exact: true }).last()).toBeVisible();

      await page.getByRole("button", { name: "Queue message", exact: true }).click();
      await page.keyboard.up("Control");

      await expectComposerDraft(page, "");
      await expect(
        page.getByRole("button", { name: "Send queued message now", exact: true }),
      ).toBeVisible();
    } finally {
      await page.keyboard.up("Control").catch(() => undefined);
      await agent.cleanup();
    }
  });

  test("keeps the default Queue action's existing icon", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-default-queue-icon-",
      title: "Composer default Queue icon",
      model: "one-minute-stream",
    });

    try {
      await gotoAppShell(page);
      await openSettings(page);
      await page.getByRole("button", { name: "Default send: Steer", exact: true }).click();
      await page.getByRole("menuitem", { name: "Queue", exact: true }).click();

      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, "Keep the agent running with Queue as the default action.");
      await expectAgentReadyToInterrupt(page);

      await fillComposerDraft(page, "Keep the existing default Queue presentation.");
      await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeVisible();
      await expect(page.getByTestId("message-input-queue-icon")).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
});
