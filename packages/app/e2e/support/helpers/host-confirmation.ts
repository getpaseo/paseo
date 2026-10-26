import { expect, type Locator, type Page } from "@playwright/test";

const EXTRA_HOSTS_KEY = "@paseo:e2e-extra-hosts";

export interface LinkedHost {
  serverId: string;
  relayEndpoint: string;
  daemonPublicKeyB64: string;
}

/**
 * A pairing link that opens on the settings page. `/` redirects to
 * `/open-project` on its own, so starting in settings leaves the pairing link
 * as the only thing that can move the app to `/open-project`.
 */
export function buildPairingLink(host: LinkedHost): string {
  const offer = {
    v: 2,
    serverId: host.serverId,
    daemonPublicKeyB64: host.daemonPublicKeyB64,
    relay: { endpoint: host.relayEndpoint, useTls: false },
  };
  const encoded = Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
  return `/settings/general#offer=${encoded}`;
}

/** Loads the app from a pairing link, the way opening the link in a browser does. */
export async function openPairingLink(page: Page, link: string): Promise<void> {
  // Leave the link's page first so the link always loads the app from scratch.
  await page.goto("/");
  await page.goto(link);
}

/** Saves a relay host before the app loads, as if it had been paired in an earlier session. */
export async function saveLinkedHostBeforeLoad(page: Page, host: LinkedHost): Promise<void> {
  await page.goto("/");
  const nowIso = new Date().toISOString();
  const connectionId = `relay:${host.relayEndpoint}`;
  const savedHost = {
    serverId: host.serverId,
    label: host.serverId,
    connections: [
      {
        id: connectionId,
        type: "relay",
        relayEndpoint: host.relayEndpoint,
        useTls: false,
        daemonPublicKeyB64: host.daemonPublicKeyB64,
      },
    ],
    preferredConnectionId: connectionId,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await page.evaluate(({ key, hosts }) => localStorage.setItem(key, JSON.stringify(hosts)), {
    key: EXTRA_HOSTS_KEY,
    hosts: [savedHost],
  });
}

export function hostConfirmation(page: Page): Locator {
  return page.getByTestId("host-confirmation");
}

export async function expectHostConfirmationFor(page: Page, host: LinkedHost): Promise<void> {
  const sheet = hostConfirmation(page);
  await expect(sheet.getByText("Connect to this host?", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(sheet.getByTestId("host-confirmation-server-id")).toHaveText(host.serverId);
  await expect(sheet.getByTestId("host-confirmation-relay")).toHaveText(host.relayEndpoint);
}

export async function cancelHostConfirmation(page: Page): Promise<void> {
  await hostConfirmation(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(hostConfirmation(page)).toHaveCount(0);
}

export async function connectToConfirmedHost(page: Page): Promise<void> {
  await hostConfirmation(page).getByRole("button", { name: "Connect", exact: true }).click();
  await expect(hostConfirmation(page)).toHaveCount(0);
}

/** Checks the host picker on the settings page the app is already showing. */
export async function expectHostInHostPicker(
  page: Page,
  serverId: string,
  expected: "listed" | "not listed",
): Promise<void> {
  await page.getByTestId("settings-host-picker").click();
  await expect(page.getByTestId(`settings-host-picker-item-${serverId}`)).toHaveCount(
    expected === "listed" ? 1 : 0,
  );
  await page.keyboard.press("Escape");
}
