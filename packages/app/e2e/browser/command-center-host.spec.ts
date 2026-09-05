import { randomUUID } from "node:crypto";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { openCommandCenter } from "../support/helpers/command-center";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

test.describe("Command center host labels", () => {
  test.describe.configure({ timeout: 180_000 });

  test("selecting an agent result opens its workspace tab", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "command-center-agent-navigation-" });
    const title = `cc-navigation-${randomUUID().slice(0, 8)}`;

    try {
      const agent = await createIdleAgent(seeded.client, {
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title,
      });

      await gotoAppShell(page);
      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill(title);
      await page.keyboard.press("Enter");

      await expectAgentTabActive(page, agent.id);
    } finally {
      await seeded.cleanup();
    }
  });
});
