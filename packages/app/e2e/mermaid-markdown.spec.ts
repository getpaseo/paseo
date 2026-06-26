import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { expectComposerVisible, submitMessage } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

test.describe("Mermaid markdown", () => {
  test("renders mock-provider Mermaid fences and exposes the source view", async ({ page }) => {
    test.setTimeout(90_000);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "mermaid-markdown-",
      title: "Mermaid markdown",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await submitMessage(page, "emit synthetic mermaid");

      const fence = page.getByTestId("mermaid-fence").first();
      await expect(fence).toBeVisible({ timeout: 30_000 });
      const diagramHost = fence.getByTestId("mermaid-diagram-host");
      await expect(diagramHost).toBeVisible({ timeout: 30_000 });
      await expect(diagramHost.locator("svg")).toBeVisible({ timeout: 30_000 });

      await fence.hover();
      await fence.getByTestId("mermaid-source-toggle").click();
      await expect(fence.getByTestId("mermaid-source")).toContainText("flowchart LR", {
        timeout: 10_000,
      });
    } finally {
      await workspace.cleanup();
    }
  });
});
