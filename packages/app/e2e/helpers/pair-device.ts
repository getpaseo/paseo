import { expect, type Page } from "@playwright/test";
import type { IsolatedHostDaemon } from "./isolated-host-daemon";
import type { OutdatedDaemon } from "./daemon-update";
import { openSettings, gotoAppShell } from "./app";
import { openSettingsHost, openSettingsHostSection, seedSavedSettingsHosts } from "./settings";

export async function prepareLocalPairingHost(
  page: Page,
  daemon: IsolatedHostDaemon | OutdatedDaemon,
): Promise<void> {
  await page.addInitScript((localServerId) => {
    (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
      platform: "darwin",
      invoke: async (command: string) => {
        if (command === "desktop_daemon_status") {
          return {
            serverId: localServerId,
            status: "running",
            listen: null,
            hostname: null,
            pid: null,
            home: "",
            version: null,
            desktopManaged: true,
            error: null,
          };
        }
        if (command === "get_desktop_settings") {
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
          };
        }
        return null;
      },
      getPendingOpenProject: async () => null,
      events: { on: async () => () => undefined },
      opener: {
        openUrl: async (url: string) => {
          localStorage.setItem("@paseo:e2e-opened-url", url);
        },
      },
    };
  }, daemon.serverId);

  await seedSavedSettingsHosts(page, [
    {
      serverId: daemon.serverId,
      label: "Local pairing host",
      endpoint: "port" in daemon ? `127.0.0.1:${daemon.port}` : daemon.endpoint,
    },
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
  await expect(page.getByAltText("Pairing QR code")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pairing link" })).toHaveValue(/#offer=/);
  await expect(page.getByText("Enable relay?", { exact: true })).toHaveCount(0);
}

export async function expectPairingOffer(page: Page): Promise<void> {
  await expect(page.getByAltText("Pairing QR code")).toBeVisible();
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

export async function enableRelayAndExpectFailure(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Enable relay", exact: true }).click();
  const modal = page.getByTestId("host-page-pair-device-card");
  await expect(modal.getByRole("alert")).toContainText(
    "Relay is controlled by a daemon launch override",
  );
  await expect(modal.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await expect(modal.getByRole("textbox", { name: "Pairing link" })).toHaveCount(0);
}

export async function retryRelayAndExpectFailure(page: Page): Promise<void> {
  const modal = page.getByTestId("host-page-pair-device-card");
  await modal.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText(
    "Relay is controlled by a daemon launch override",
  );
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
