import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { openCommandCenter } from "../support/helpers/command-center";
import { addOfflineHostAndReload } from "../support/helpers/hosts";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const PRIMARY_HOST_LABEL = "Primary Host";
const SECONDARY_HOST_ID = "host-command-center-secondary";

test.describe("Command center host labels", () => {
  test.describe.configure({ timeout: 180_000 });

  test("agent results show the host they live on when more than one host exists", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({ repoPrefix: "command-center-host-" });
    const title = `cc-host-${randomUUID().slice(0, 8)}`;

    try {
      const agent = await createIdleAgent(seeded.client, {
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title,
      });

      // A second (offline) host makes the view multi-host, which is when the host label earns its space.
      await gotoAppShell(page);
      await addOfflineHostAndReload(page, {
        serverId: SECONDARY_HOST_ID,
        label: "Secondary Host",
        primaryLabel: PRIMARY_HOST_LABEL,
      });

      const panel = await openCommandCenter(page);

      // The shared daemon may carry agents from other specs, so target this agent by its id.
      const row = panel.getByTestId(`command-center-agent-${getServerId()}:${agent.id}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(title);
      await expect(row).toContainText(PRIMARY_HOST_LABEL);
    } finally {
      await seeded.cleanup();
    }
  });

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
