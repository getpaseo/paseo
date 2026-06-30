import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { createIdleAgent } from "./helpers/archive-tab";
import { appendOfflineHost } from "./helpers/hosts";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

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
      await appendOfflineHost(page, {
        serverId: SECONDARY_HOST_ID,
        label: "Secondary Host",
        primaryLabel: PRIMARY_HOST_LABEL,
      });
      await gotoAppShell(page);

      await page.getByTestId("sidebar-command-center-search").click();
      const panel = page.getByTestId("command-center-panel");
      await expect(panel).toBeVisible({ timeout: 30_000 });

      // The shared daemon may carry agents from other specs, so target this agent by its id.
      const row = panel.getByTestId(`command-center-agent-${getServerId()}:${agent.id}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(title);
      await expect(row).toContainText(PRIMARY_HOST_LABEL);
    } finally {
      await seeded.cleanup();
    }
  });
});
