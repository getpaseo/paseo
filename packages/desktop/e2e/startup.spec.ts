import { test } from "../../app/e2e/support/fixtures";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { startupScenario } from "../../app/e2e/support/helpers/startup-dsl";

test.describe("Desktop startup", () => {
  test("daemon bootstrap keeps the local server startup copy desktop-only", async ({ page }) => {
    const startup = await startupScenario(page)
      .withPendingDesktopDaemon()
      .withBlockedPort(getE2EDaemonPort())
      .openRoot();

    await startup.expectsDesktopDaemonStartup();
    await startup.expectsSidebarHidden();
    await startup.expectsNoUndefinedRoute();
  });

  test("host-route refresh does not render route chrome around the bootstrap splash", async ({
    page,
  }) => {
    const startup = await startupScenario(page)
      .withPendingDesktopDaemon()
      .withBlockedPort(getE2EDaemonPort())
      .openHostWorkspace({
        serverId: getServerId(),
        workspaceId: "workspace-1",
      });

    await startup.expectsDesktopDaemonStartup();
    await startup.expectsSidebarHidden();
  });
});
