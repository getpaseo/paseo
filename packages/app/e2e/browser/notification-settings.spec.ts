import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  clearRecordedBrowserNotifications,
  clickRecordedBrowserNotification,
  expectDefaultNotificationSettings,
  expectNotificationSubControlsDisabled,
  expectNotificationSwitchState,
  expectRecordedAgentNotifications,
  expectRecordedPluginNotifications,
  installBrowserNotificationRecorder,
  openNotificationSettings,
  readRecordedBrowserNotifications,
  setNotificationSwitch,
  setPluginNotificationSwitch,
} from "../support/helpers/notification-settings";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";

const FAST_FINISHED_PROMPT =
  "emit settled assistant image markdown: ![done](https://example.com/done.png)";
const PERMISSION_PROMPT = "emit a synthetic plan approval";
const ERROR_PROMPT = "emit a synthetic turn failure";

async function runMockAgentTurn(
  client: SeedDaemonClient,
  input: {
    cwd: string;
    workspaceId: string;
    title: string;
    prompt: string;
    waitForStatus: "idle" | "error" | "running";
  },
): Promise<string> {
  const agent = await client.createAgent({
    provider: "mock",
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    title: input.title,
    modeId: "load-test",
    model: "e2e-fast-stream",
    initialPrompt: input.prompt,
  });
  await client.waitForAgentUpsert(
    agent.id,
    (snapshot) => snapshot.status === input.waitForStatus,
    15_000,
  );
  return agent.id;
}

test.describe("Settings → Notifications and OS notification filtering", () => {
  test("displays defaults, persists switch changes across reload, disables sub-controls when paused, and filters OS notifications", async ({
    page,
  }) => {
    await installBrowserNotificationRecorder(page);
    const seeded = await seedWorkspace({ repoPrefix: "notification-settings-" });
    const pluginExample = await copyPluginExample("notifications");
    let installedPlugin = false;

    try {
      await gotoAppShell(page);
      await openSettings(page);
      await openNotificationSettings(page);

      await test.step("renders Settings → Notifications with expected out-of-the-box defaults", async () => {
        await expectDefaultNotificationSettings(page);
        await expect(
          page.getByText("Installed plugins appear here so you can mute them individually", {
            exact: true,
          }),
        ).toBeVisible();
      });

      await test.step("default preferences suppress finished turn notifications while delivering permission and error notifications", async () => {
        await clearRecordedBrowserNotifications(page);

        await runMockAgentTurn(seeded.client, {
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "Default finished agent",
          prompt: FAST_FINISHED_PROMPT,
          waitForStatus: "idle",
        });

        const permissionAgentId = await runMockAgentTurn(seeded.client, {
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "Default permission agent",
          prompt: PERMISSION_PROMPT,
          waitForStatus: "running",
        });

        const errorAgentId = await runMockAgentTurn(seeded.client, {
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "Default error agent",
          prompt: ERROR_PROMPT,
          waitForStatus: "error",
        });

        await expectRecordedAgentNotifications(page, [
          { agentId: permissionAgentId, reason: "permission" },
          { agentId: errorAgentId, reason: "error" },
        ]);
      });

      await test.step("enabling Agent finished persists across page reload and allows finished notifications", async () => {
        await setNotificationSwitch(page, "Agent finished", true);
        await page.reload();
        await expectNotificationSwitchState(page, "Agent finished", {
          checked: true,
          disabled: false,
        });

        await clearRecordedBrowserNotifications(page);

        const finishedAgentId = await runMockAgentTurn(seeded.client, {
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "Enabled finished agent",
          prompt: FAST_FINISHED_PROMPT,
          waitForStatus: "idle",
        });

        await expectRecordedAgentNotifications(page, [
          { agentId: finishedAgentId, reason: "finished" },
        ]);
      });

      await test.step("toggling Enable notifications off disables sub-controls, persists across reload, and suppresses all notifications", async () => {
        await setNotificationSwitch(page, "Enable notifications", false);
        await expect(
          page.getByText("All notifications, including plugins, are paused on this device", {
            exact: true,
          }),
        ).toBeVisible();
        await expectNotificationSubControlsDisabled(page, true);

        await page.reload();
        await expectNotificationSwitchState(page, "Enable notifications", {
          checked: false,
          disabled: false,
        });
        await expectNotificationSubControlsDisabled(page, true);

        await clearRecordedBrowserNotifications(page);

        await runMockAgentTurn(seeded.client, {
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "Paused error agent",
          prompt: ERROR_PROMPT,
          waitForStatus: "error",
        });

        await runMockAgentTurn(seeded.client, {
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "Paused finished agent",
          prompt: FAST_FINISHED_PROMPT,
          waitForStatus: "idle",
        });

        // Give any in-flight event delivery a chance to settle and verify none fired.
        await page.waitForTimeout(300);
        expect(await readRecordedBrowserNotifications(page)).toEqual([]);
      });

      await test.step("delivers plugin notifications, routes OS notification taps through client.onNotificationOpen, and suppresses notifications when the plugin is muted", async () => {
        await setNotificationSwitch(page, "Enable notifications", true);
        await seeded.client.patchDaemonConfig({ pluginsEnabled: true });
        await seeded.client.installDirectoryPlugin(pluginExample.directory);
        installedPlugin = true;

        const pluginToggle = page.getByRole("switch", { name: "Build alerts", exact: true });
        await expect(pluginToggle).toBeVisible();
        await expect(pluginToggle).toHaveAttribute("aria-checked", "true");

        await clearRecordedBrowserNotifications(page);

        const sent = (await seeded.client.invokePluginRpc("notifications-example", "alerts.send", {
          buildId: "204",
          title: "Build #204 failed",
          body: "Playwright suite failed on main",
        })) as { status: string; notificationId: string };
        expect(sent.status).toBe("sent");

        await expectRecordedPluginNotifications(page, [
          {
            pluginId: "notifications-example",
            title: "Build #204 failed",
            body: "Playwright suite failed on main",
            notificationId: sent.notificationId,
          },
        ]);

        await clickRecordedBrowserNotification(page, 0);
        await expect(page.getByText("Build alert #204", { exact: true })).toBeVisible();
        await expect(
          page.getByText("Playwright suite failed on main", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(`Notification ID: ${sent.notificationId}`, { exact: true }),
        ).toBeVisible();

        await openSettings(page);
        await openNotificationSettings(page);
        await setPluginNotificationSwitch(page, "Build alerts", false);
        await clearRecordedBrowserNotifications(page);

        const mutedResult = (await seeded.client.invokePluginRpc(
          "notifications-example",
          "alerts.send",
          {
            buildId: "205",
            title: "Build #205 failed",
            body: "Muted build alert",
          },
        )) as { status: string };
        expect(mutedResult.status).toBe("sent");

        // Trigger an unmuted agent error notification so we prove delivery settled and only
        // the unmuted notification arrived (Build #205 was suppressed).
        const sentinelErrorAgentId = await runMockAgentTurn(seeded.client, {
          cwd: seeded.repoPath,
          workspaceId: seeded.workspaceId,
          title: "Sentinel unmuted error agent",
          prompt: ERROR_PROMPT,
          waitForStatus: "error",
        });

        await expectRecordedAgentNotifications(page, [
          { agentId: sentinelErrorAgentId, reason: "error" },
        ]);
      });
    } finally {
      if (installedPlugin) {
        await seeded.client.removePlugin("notifications-example").catch(() => undefined);
      }
      await pluginExample.cleanup().catch(() => undefined);
      await seeded.cleanup();
    }
  });
});
