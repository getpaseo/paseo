import { expect, type Page } from "@playwright/test";
import type { IsolatedHostDaemon } from "./isolated-host-daemon";
import type { OutdatedDaemon } from "./daemon-update";
import { openSettings, gotoAppShell } from "./app";
import {
  openSettingsHost,
  openSettingsHostSection,
  seedSavedSettingsHosts,
  selectSettingsHost,
} from "./settings";
import { expectAppRoute } from "./route-assertions";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

interface PairingHostInput {
  serverId: string;
  label: string;
  endpoint: string;
}

export async function preparePairingHost(
  page: Page,
  daemon: IsolatedHostDaemon | OutdatedDaemon,
  additionalHosts: PairingHostInput[] = [],
): Promise<void> {
  await seedSavedSettingsHosts(page, [
    {
      serverId: daemon.serverId,
      label: "Local pairing host",
      endpoint: "port" in daemon ? `127.0.0.1:${daemon.port}` : daemon.endpoint,
    },
    ...additionalHosts,
  ]);
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, daemon.serverId);
  await expect(page.getByTestId("host-page-pair-device-row")).toHaveCount(0);
  await openSettingsHostSection(page, daemon.serverId, "pair-device");
  await expect(page.getByTestId("host-page-pair-device-row")).toBeVisible();
}

export async function openPairDeviceModal(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Pair a device/ }).click();
  await expect(page.getByTestId("host-page-pair-device-card")).toBeVisible();
}

export async function expectRelayConsent(page: Page): Promise<void> {
  const modal = page.getByTestId("host-page-pair-device-card");
  await expect(modal.getByText("Enable relay?", { exact: true })).toBeVisible();
  await expect(modal.getByText(/end-to-end encrypted/)).toBeVisible();
  await expect(modal.getByRole("link", { name: "Read how Paseo relay works" })).toBeVisible();
  await expect(modal.getByText(/TCP, Tailscale, or another VPN/)).toBeVisible();
  await expect(modal.getByRole("img", { name: "Pairing QR code" })).toHaveCount(0);
  await expect(modal.getByRole("textbox", { name: "Pairing link" })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
}

export async function declineRelay(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.getByTestId("host-page-pair-device-card")).toHaveCount(0);
}

export async function enableRelayAndExpectOffer(page: Page): Promise<void> {
  const enableButton = page.getByRole("button", { name: "Enable relay", exact: true });
  await enableButton.click();
  await expect(page.getByRole("button", { name: "Enabling...", exact: true })).toBeDisabled();
  await expect(page.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pairing link" })).toHaveValue(/#offer=/);
  await expect(page.getByText("Enable relay?", { exact: true })).toHaveCount(0);
}

export async function expectPairingOffer(page: Page): Promise<void> {
  await expect(page.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pairing link" })).toHaveValue(/#offer=/);
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable relay", exact: true })).toHaveCount(0);
}

export async function closePairDeviceModal(page: Page): Promise<void> {
  await page
    .getByTestId("host-page-pair-device-card")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByTestId("host-page-pair-device-card")).toHaveCount(0);
}

export async function reloadAndOpenPairDevice(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
    if (!nonce) throw new Error("Expected e2e seed nonce");
    localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
  });
  await page.reload();
  await openPairDeviceModal(page);
}

export async function enableRelayAndExpectFailure(
  page: Page,
  expectedError = "Relay is controlled by a daemon launch override",
): Promise<void> {
  await page.getByRole("button", { name: "Enable relay", exact: true }).click();
  const modal = page.getByTestId("host-page-pair-device-card");
  await expect(modal.getByRole("alert")).toContainText(expectedError);
  await expect(modal.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await expect(modal.getByRole("textbox", { name: "Pairing link" })).toHaveCount(0);
}

export async function retryRelayAndExpectFailure(
  page: Page,
  expectedError = "Relay is controlled by a daemon launch override",
): Promise<void> {
  const modal = page.getByTestId("host-page-pair-device-card");
  await modal.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText(expectedError);
  await expect(modal.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
}

export async function openPairDeviceFromHome(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
    if (!nonce) throw new Error("Expected e2e seed nonce");
    localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
  });
  await page.goto("/open-project");
  await page.getByTestId("open-project-pair-device").click();
  await expect(page.getByTestId("open-project-pair-device-modal")).toBeVisible();
}

export async function expectRelayUpdateRequired(page: Page): Promise<void> {
  const modal = page.getByTestId("host-page-pair-device-card");
  await expect(
    modal.getByText("Update the host to enable relay from Paseo Desktop."),
  ).toBeVisible();
  await expect(modal.getByRole("button", { name: "Enable relay", exact: true })).toHaveCount(0);
  await expect(modal.getByRole("textbox", { name: "Pairing link" })).toHaveCount(0);
}

export function observePairingOfferRequests(page: Page, daemon: OutdatedDaemon): () => void {
  let requestCount = 0;
  const port = daemon.endpoint.slice(daemon.endpoint.lastIndexOf(":") + 1);
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`:${port}`)) return;
    socket.on("framesent", ({ payload }) => {
      const message = typeof payload === "string" ? payload : payload.toString();
      if (message.includes('"type":"daemon.get_pairing_offer.request"')) requestCount += 1;
    });
  });
  return () => expect(requestCount).toBe(0);
}

export async function expectPairingDisconnected(page: Page): Promise<void> {
  const modal = page.getByTestId("host-page-pair-device-card");
  await expect(modal.getByRole("alert")).toContainText("Host is not connected");
  await expect(modal.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
}

export async function switchPairDeviceToHost(page: Page, serverId: string): Promise<void> {
  await selectSettingsHost(page, serverId);
  await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, "pair-device"));
  await expect(page.getByTestId("host-page-pair-device-row")).toBeVisible();
}

export async function openRelaySecurityDocs(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Read how Paseo relay works" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("@paseo:e2e-opened-url")))
    .toBe("https://paseo.sh/docs/security");
}

export function expectDaemonPidUnchanged(
  before: number | undefined,
  after: number | undefined,
): void {
  expect(before).toBeDefined();
  expect(after).toBe(before);
}
