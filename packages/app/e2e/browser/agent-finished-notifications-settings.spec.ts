import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  expectSettingsHeader,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

interface SessionEnvelope {
  type?: string;
  message?: { type?: string; requestId?: string };
}

// Answers matching daemon requests with an RPC error once release() is called. With
// repeat, every match fails until stop(), since the app retries failed config loads.
async function interceptDaemonRequest(
  page: Page,
  requestType: string,
  options: { repeat?: boolean } = {},
) {
  let active = true;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markSeen: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    markSeen = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    const failLater = async (requestId: string) => {
      await released;
      browser.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "rpc_error",
            payload: {
              requestId,
              requestType,
              error: "Injected config failure.",
              code: "handler_error",
            },
          },
        }),
      );
    };
    browser.onMessage((message) => {
      if (typeof message !== "string") {
        server.send(message);
        return;
      }
      let envelope: SessionEnvelope | null = null;
      try {
        envelope = JSON.parse(message) as SessionEnvelope;
      } catch {
        server.send(message);
        return;
      }
      const request = envelope?.type === "session" ? envelope.message : null;
      if (active && request?.type === requestType && request.requestId) {
        active = options.repeat === true;
        markSeen?.();
        void failLater(request.requestId);
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      // The app also takes the config from status pushes, so a failing load drops them.
      if (
        active &&
        options.repeat === true &&
        typeof message === "string" &&
        message.includes('"daemon_config_changed"')
      ) {
        return;
      }
      browser.send(message);
    });
  });

  return {
    seen,
    release: () => release?.(),
    stop: () => {
      active = false;
    },
  };
}

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

test("shows progress and an inline error when saving finished notifications fails", async ({
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const finishedNotifications = page.getByRole("switch", {
    name: "Notify when an agent finishes",
    exact: true,
  });

  try {
    await client.patchDaemonConfig({ agentFinishedNotifications: true });
    const failure = await interceptDaemonRequest(page, "set_daemon_config_request");
    await openAgentsSettings(page);
    await expect(finishedNotifications).toBeChecked();

    await finishedNotifications.click();
    await failure.seen;
    await expect(page.getByTestId("host-page-agent-finished-notifications-saving")).toBeVisible();
    await expect(finishedNotifications).toBeDisabled();

    failure.release();

    await expect(page.getByTestId("host-page-agent-finished-notifications-error")).toContainText(
      "Injected config failure.",
    );
    await expect(page.getByTestId("host-page-agent-finished-notifications-saving")).toHaveCount(0);
    await expect(finishedNotifications).toBeEnabled();
    await expect(finishedNotifications).toBeChecked();
    expect((await client.getDaemonConfig()).config.agentFinishedNotifications).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("offers a retry when the host config fails to load", async ({ page }) => {
  const failure = await interceptDaemonRequest(page, "get_daemon_config_request", {
    repeat: true,
  });
  failure.release();
  await openAgentsSettings(page);

  // The load error appears once the app's automatic retries are exhausted.
  await expect(page.getByTestId("host-page-agent-finished-notifications-load-error")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("switch", { name: "Notify when an agent finishes", exact: true }),
  ).toHaveCount(0);

  failure.stop();
  await page.getByTestId("host-page-agent-finished-notifications-retry").click();

  await expect(
    page.getByRole("switch", { name: "Notify when an agent finishes", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("host-page-agent-finished-notifications-load-error")).toHaveCount(
    0,
  );
});
