import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  clearRecordedBrowserNotifications,
  expectDefaultNotificationSettings,
  expectNotificationSubControlsDisabled,
  expectNotificationSwitchState,
  expectRecordedAgentNotifications,
  installBrowserNotificationRecorder,
  openNotificationSettings,
  readRecordedBrowserNotifications,
  setNotificationSwitch,
} from "../support/helpers/notification-settings";
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
    } finally {
      await seeded.cleanup();
    }
  });
});
