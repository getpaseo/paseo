import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const FIND_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Browser-level coverage for find-in-conversation: a real Cmd/Ctrl+F keystroke
 * through the app's window listener, real find bar, and real scrolling. The
 * transcript is built from user messages so the assertions do not depend on
 * mock-provider streaming content.
 */
test.describe("Find in conversation", () => {
  test("finds, counts, and navigates matches from a real keystroke", async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "find-in-conversation-",
      title: "Find in conversation",
    });

    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      await workspace.client.sendAgentMessage(workspace.agentId, "first prompt about zebra");
      await workspace.client.sendAgentMessage(workspace.agentId, "unrelated prompt");
      await workspace.client.sendAgentMessage(
        workspace.agentId,
        "third prompt about zebra and zebra again",
      );
      const firstMatchMessage = page
        .getByTestId("user-message")
        .filter({ hasText: "first prompt" });
      const thirdMatchMessage = page
        .getByTestId("user-message")
        .filter({ hasText: "third prompt" });
      await expect(thirdMatchMessage).toBeVisible({ timeout: 30_000 });

      const findBar = page.getByTestId("session-find-bar");
      await expect(findBar).toBeHidden();

      await page.keyboard.press(`${FIND_MODIFIER}+f`);
      await expect(findBar).toBeVisible();

      // The find input takes focus on open, so the query can be typed directly.
      await page.keyboard.type("zebra");

      // One occurrence in the first message, two in the third.
      const count = page.getByTestId("session-find-count");
      await expect(count).toHaveText("1/3");
      await expect(firstMatchMessage).toBeInViewport();

      await page.getByTestId("session-find-next").click();
      await expect(count).toHaveText("2/3");
      await expect(thirdMatchMessage).toBeInViewport();

      await page.getByTestId("session-find-next").click();
      await expect(count).toHaveText("3/3");
      await expect(thirdMatchMessage).toBeInViewport();

      // Forward from the last match wraps to the first.
      await page.getByTestId("session-find-next").click();
      await expect(count).toHaveText("1/3");
      await expect(firstMatchMessage).toBeInViewport();

      // Backward from the first match wraps to the last.
      await page.getByTestId("session-find-previous").click();
      await expect(count).toHaveText("3/3");
      await expect(thirdMatchMessage).toBeInViewport();

      await page.keyboard.press("Escape");
      await expect(findBar).toBeHidden();
    } finally {
      await workspace.cleanup();
    }
  });

  test("scrolls an off-screen match into view", async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "find-in-conversation-scroll-",
      title: "Find in conversation scroll",
    });

    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      // The needle goes in the only user message; the mock's streamed reply then
      // grows past the viewport while auto-scroll follows the bottom, pushing the
      // marker off screen.
      await workspace.client.sendAgentMessage(workspace.agentId, "needle marker message");
      const marker = page.getByTestId("user-message").filter({ hasText: "needle marker" }).first();
      await expect(marker).toBeVisible({ timeout: 30_000 });
      await expect(marker).not.toBeInViewport({ timeout: 60_000 });

      await page.keyboard.press(`${FIND_MODIFIER}+f`);
      await expect(page.getByTestId("session-find-bar")).toBeVisible();
      await page.keyboard.type("needle");

      await expect(page.getByTestId("session-find-count")).toHaveText("1/1");
      await expect(marker).toBeInViewport();
    } finally {
      await workspace.cleanup();
    }
  });
});
