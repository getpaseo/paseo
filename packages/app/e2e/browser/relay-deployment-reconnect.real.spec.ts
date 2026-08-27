import { test } from "@playwright/test";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { expectRunningAgentChrome } from "../support/helpers/agent-stream";
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
