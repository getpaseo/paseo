import { expect, type Page } from "@playwright/test";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import type { LocalElixirRelay } from "./local-elixir-relay";
import type { PackagedWebDaemon } from "./packaged-web-daemon";
import { expectRunningAgentChrome } from "./agent-stream";
import { buildCreateAgentPreferences } from "./daemon-registry";

export interface RelayDeploymentMeasurements {
  reconnectToastDelayMs: number;
  reconnectToastVisibleMs: number;
  totalReconnectMs: number;
  relayStartupMs: number;
  streamPausedWhileDisconnected: boolean;
  runningStatePreserved: boolean;
  streamResumedWithoutUserAction: boolean;
}

export async function connectDaemonWebAppOnlyThroughRelay(
  page: Page,
  daemon: PackagedWebDaemon,
): Promise<void> {
  const offerUrl = await daemon.pairingOfferUrl();
  const offer = parseConnectionOfferFromUrl(offerUrl);
  if (!offer) throw new Error("Daemon pairing command returned an invalid offer URL");
  const relayConnection = {
    id: `relay:${offer.relay.endpoint}`,
    type: "relay" as const,
    relayEndpoint: offer.relay.endpoint,
    useTls: offer.relay.useTls ?? false,
    daemonPublicKeyB64: offer.daemonPublicKeyB64,
  };
  const now = new Date().toISOString();
  const host = {
    serverId: offer.serverId,
    label: "Relay deployment host",
    connections: [relayConnection],
    preferredConnectionId: relayConnection.id,
    createdAt: now,
    updatedAt: now,
  };

  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767)\b/, async (socket) => {
    await socket.close({ code: 1008, reason: "Blocked developer daemon during relay E2E" });
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replace(/<script>window\.__PASEO_INITIAL_DAEMON_CONNECTION__=.*?<\/script>/, ""),
    });
  });
  await page.addInitScript(
    ({ storedHost, preferences }) => {
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([storedHost]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
    },
    { storedHost: host, preferences: buildCreateAgentPreferences(offer.serverId) },
  );

  const relaySocketOpened = new Promise<void>((resolve) => {
    page.on("websocket", (socket) => {
      if (socket.url().includes(offer.relay.endpoint)) resolve();
    });
  });
  await page.goto(daemon.origin);
  await relaySocketOpened;
  await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 30_000 });
}

async function latestAssistantText(page: Page): Promise<string> {
  return (await page.getByTestId("assistant-message").last().innerText()).trim();
}

async function waitForAssistantTextToGrow(page: Page, previous: string): Promise<void> {
  await expect.poll(() => latestAssistantText(page), { timeout: 30_000 }).not.toBe(previous);
}

async function expectRunningStatusPreserved(page: Page, agentTitle: string): Promise<void> {
  const tab = page.getByRole("button", { name: agentTitle, exact: true });
  await expect(tab.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
}

export async function measureRelayRestartDuringStream(input: {
  page: Page;
  relay: LocalElixirRelay;
  agentTitle: string;
}): Promise<RelayDeploymentMeasurements> {
  const { page, relay, agentTitle } = input;
  const toast = page.getByTestId("agent-reconnecting-toast");
  const beforeOutage = await latestAssistantText(page);
  await waitForAssistantTextToGrow(page, beforeOutage);

  const outageStartedAt = performance.now();
  const toastVisibleAtPromise = toast
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => performance.now());
  await relay.stop();
  const toastVisibleAt = await toastVisibleAtPromise;

  await expectRunningStatusPreserved(page, agentTitle);
  await page.waitForTimeout(750);
  const disconnectedText = await latestAssistantText(page);
  await page.waitForTimeout(1_000);
  const streamPausedWhileDisconnected = (await latestAssistantText(page)) === disconnectedText;
  expect(streamPausedWhileDisconnected).toBe(true);

  const relayStartAt = performance.now();
  await relay.start();
  const relayReadyAt = performance.now();
  await toast.waitFor({ state: "hidden", timeout: 30_000 });
  const reconnectedAt = performance.now();

  await expectRunningAgentChrome(page, agentTitle);
  await waitForAssistantTextToGrow(page, disconnectedText);

  return {
    reconnectToastDelayMs: Math.round(toastVisibleAt - outageStartedAt),
    reconnectToastVisibleMs: Math.round(reconnectedAt - toastVisibleAt),
    totalReconnectMs: Math.round(reconnectedAt - outageStartedAt),
    relayStartupMs: Math.round(relayReadyAt - relayStartAt),
    streamPausedWhileDisconnected,
    runningStatePreserved: true,
    streamResumedWithoutUserAction: true,
  };
}
