import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import {
  expectSettingsHeader,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

async function openAgentsSettings(page: Page) {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "agents");
  await expectSettingsHeader(page, "Agents");
}

test("turns off agent finished notifications on the host and keeps the choice", async ({
  page,
}, testInfo) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const finishedNotifications = page.getByRole("switch", {
    name: "Notify when an agent finishes",
    exact: true,
  });

  try {
    await client.patchDaemonConfig({ agentFinishedNotifications: true });
    await openAgentsSettings(page);

    await expect(page.getByTestId("host-page-agent-finished-notifications-card")).toBeVisible();
    await expect(finishedNotifications).toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath("agent-finished-notifications-on.png"),
      fullPage: true,
    });

    await finishedNotifications.click();

    await expect(finishedNotifications).not.toBeChecked();
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.agentFinishedNotifications)
      .toBe(false);

    await page.reload();
    await expect(finishedNotifications).not.toBeChecked();
    // Let the switch thumb finish its 180ms slide so the screenshot shows the settled state.
    await page.waitForTimeout(300);
    await page.screenshot({
      path: testInfo.outputPath("agent-finished-notifications-off.png"),
      fullPage: true,
    });

    await finishedNotifications.click();
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.agentFinishedNotifications)
      .toBe(true);
  } finally {
    try {
      await client.patchDaemonConfig({ agentFinishedNotifications: true });
    } finally {
      await client.close().catch(() => undefined);
    }
  }
});
