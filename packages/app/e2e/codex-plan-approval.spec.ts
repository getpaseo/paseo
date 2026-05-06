import { expect, test } from "./fixtures";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { allowPermission, waitForPermissionPrompt } from "./helpers/permissions";
import { connectTerminalClient } from "./helpers/terminal-perf";
import { createTempGitRepo } from "./helpers/workspace";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

test.describe("Codex plan approval", () => {
  test("shows a single actionable plan panel and removes it after implementation starts", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const repo = await createTempGitRepo("codex-plan-approval-");
    const client = await connectTerminalClient();

    try {
      const workspaceResult = await client.openProject(repo.path);
      if (!workspaceResult.workspace) {
        throw new Error(workspaceResult.error ?? `Failed to open project ${repo.path}`);
      }

      const agent = await client.createAgent({
        provider: "mock",
        cwd: repo.path,
        title: "Codex plan approval e2e",
        modeId: "load-test",
        model: "ten-second-stream",
        initialPrompt: "Emit synthetic plan approval.",
      });

      const agentUrl = `${buildHostWorkspaceRoute(
        getServerId(),
        repo.path,
      )}?open=${encodeURIComponent(`agent:${agent.id}`)}`;
      await page.goto(agentUrl);

      await waitForPermissionPrompt(page, 120_000);

      await expect(page.getByTestId("permission-plan-card")).toHaveCount(1);
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);

      await allowPermission(page);

      await expect(page.getByTestId("permission-plan-card")).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
