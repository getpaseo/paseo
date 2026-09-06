import { expect, test } from "@playwright/test";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { expectRunningAgentChrome } from "../support/helpers/agent-stream";
import { openSettings } from "../support/helpers/app";
import { startLocalElixirRelay } from "../support/helpers/local-elixir-relay";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  startPackagedWebDaemon,
  type PackagedWebDaemon,
} from "../support/helpers/packaged-web-daemon";
import {
  connectDaemonWebAppOnlyThroughRelay,
  measureRelayRestartDuringStream,
} from "../support/helpers/relay-deployment";
import { openSettingsHost } from "../support/helpers/settings";

test("relay settings migrate the app to the new relay without user action", async ({ page }) => {
  test.setTimeout(180_000);
  const oldRelay = await startLocalElixirRelay();
  const newRelay = await startLocalElixirRelay();
  let daemon: PackagedWebDaemon | null = null;

  try {
    daemon = await startPackagedWebDaemon({ relayEndpoint: oldRelay.endpoint });
    await connectDaemonWebAppOnlyThroughRelay(page, daemon);
    await openSettings(page);
    await openSettingsHost(page, daemon.serverId);

    const relayCard = page.getByTestId("host-page-relay-card");
    await relayCard.getByTestId("host-page-relay-configure-button").click();
    await page.getByTestId("relay-endpoint-input").fill(newRelay.endpoint);
    await page.getByTestId("relay-public-endpoint-input").fill(newRelay.endpoint);

    let newRelaySocketOpened = false;
    page.on("websocket", (socket) => {
      if (socket.url().includes(newRelay.endpoint)) newRelaySocketOpened = true;
    });
    await page.getByTestId("relay-settings-save-button").click();

    await expect.poll(() => newRelaySocketOpened, { timeout: 90_000 }).toBe(true);
    await expect(page.getByTestId("relay-settings-modal")).toHaveCount(0, { timeout: 30_000 });
    await expect(relayCard).toContainText(`Daemon endpoint: ${newRelay.endpoint}`);
    await expect(relayCard).toContainText(`Public endpoint: ${newRelay.endpoint}`);
  } finally {
    try {
      await daemon?.close();
    } finally {
      try {
        await oldRelay.close();
      } finally {
        await newRelay.close();
      }
    }
  }
});

test("a streaming chat recovers from a relay deployment without user action", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const relay = await startLocalElixirRelay();
  let daemon: PackagedWebDaemon | null = null;
  let cleanupChat = async () => {};

  try {
    daemon = await startPackagedWebDaemon({ relayEndpoint: relay.endpoint });
    const runningDaemon = daemon;
    await test.step("Connect the daemon-served app only through the relay", async () => {
      await connectDaemonWebAppOnlyThroughRelay(page, runningDaemon);
    });

    await test.step("Open a running mock-provider chat", async () => {
      const chat = await seedMockAgentWorkspace({
        repoPrefix: "relay-deployment-reconnect-",
        title: "Relay deployment stream",
        port: runningDaemon.port,
        model: "five-minute-stream",
        initialPrompt: "Stream while the relay is deployed.",
      });
      cleanupChat = chat.cleanup;
      const route = buildHostAgentDetailRoute(
        runningDaemon.serverId,
        chat.agentId,
        chat.workspaceId,
      );
      await page.goto(new URL(route, runningDaemon.origin).toString());
      await expectRunningAgentChrome(page, "Relay deployment stream");
    });

    await test.step("Restart the relay and measure the visible interruption", async () => {
      const measurements = await measureRelayRestartDuringStream({
        page,
        relay,
        agentTitle: "Relay deployment stream",
      });
      await testInfo.attach("relay-deployment-measurements", {
        body: JSON.stringify(measurements, null, 2),
        contentType: "application/json",
      });
      console.log(`Relay deployment measurements: ${JSON.stringify(measurements)}`);
    });
  } finally {
    try {
      await cleanupChat();
    } finally {
      try {
        await daemon?.close();
      } finally {
        await relay.close();
      }
    }
  }
});
