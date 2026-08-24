import { test } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { getE2EDaemonPort, wsRoutePatternForPort } from "../support/helpers/daemon-port";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  addDirectHostFromSettings,
  clickSettingsBackToWorkspace,
  openSettingsHostSection,
} from "../support/helpers/settings";
import { seedWorkspace } from "../support/helpers/seed-client";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";

test.describe("Settings host selection", () => {
  test.describe.configure({ timeout: 180_000 });

  test("entering Settings from a remote workspace selects that remote host", async ({ page }) => {
    const remoteDaemon = await startIsolatedHostDaemon("settings-host-selection-remote");
    const remoteWorkspace = await seedWorkspace({
      port: remoteDaemon.port,
      repoPrefix: "settings-host-selection-remote-workspace-",
      title: "Remote workspace",
    });

    try {
      // The default local profile remains in the registry, but its daemon is offline.
      await page.routeWebSocket(wsRoutePatternForPort(getE2EDaemonPort()), async (ws) => {
        await ws.close({ code: 1008, reason: "The local daemon is disconnected." });
      });

      await page.goto("/");
      await openSettings(page);
      await addDirectHostFromSettings(page, {
        host: "127.0.0.1",
        port: remoteDaemon.port,
      });

      await clickSettingsBackToWorkspace(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId: remoteDaemon.serverId,
        workspaceId: remoteWorkspace.workspaceId,
      });

      await openSettings(page);

      await openSettingsHostSection(page, remoteDaemon.serverId, "connections");
    } finally {
      await remoteWorkspace.cleanup().catch(() => undefined);
      await remoteDaemon.close().catch(() => undefined);
    }
  });
});
