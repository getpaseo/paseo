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
import { wsRoutePatternForPort } from "./daemon-port";
import { goToSetupStep, showSetupAgainFromSettings } from "./onboarding";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

interface PairingHostInput {
  serverId: string;
  label: string;
  endpoint: string;
}

export async function prepareLocalPairingHost(
  page: Page,
  daemon: IsolatedHostDaemon | OutdatedDaemon,
  additionalHosts: PairingHostInput[] = [],
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

  await preparePairingHost(page, daemon, additionalHosts);
}

type PairingHost =
  | Pick<IsolatedHostDaemon, "serverId" | "port">
  | Pick<OutdatedDaemon, "serverId" | "endpoint">;

export async function preparePairingHost(
  page: Page,
  daemon: PairingHost,
  additionalHosts: PairingHostInput[] = [],
): Promise<void> {
  await openAppOnPairingHost(page, daemon, additionalHosts);
  await openSettings(page);
  await openSettingsHost(page, daemon.serverId);
  await expect(page.getByTestId("devices-relay")).toHaveCount(0);
  await openSettingsHostSection(page, daemon.serverId, "devices");
  await expect(page.getByTestId("devices-relay")).toBeVisible();
}

/** Loads the app afresh with `daemon` as its first host, then opens the setup's Mobile step. */
export async function openSetupMobileStep(page: Page, daemon: PairingHost): Promise<void> {
  await openAppOnPairingHost(page, daemon);
  await showSetupAgainFromSettings(page);
  await goToSetupStep(page, "Mobile");
}

async function openAppOnPairingHost(
  page: Page,
  daemon: PairingHost,
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
}

export async function enableTailscale(page: Page): Promise<void> {
  const toggle = page.getByRole("switch", { name: "Tailscale", exact: true });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
}

export async function expectTailscaleAddress(page: Page, address: string): Promise<void> {
  const row = tailscaleAddressRow(page, address);
  await expect(row).toBeVisible();
  await expect(
    row.getByText("On a phone with Tailscale, add a host at this address"),
  ).toBeVisible();
  await expect(row.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  const response = await fetch(`http://${address}/api/health`);
  expect(response.ok).toBe(true);
}

/** The switch shows off as soon as it is tapped; the host stops listening when its answer lands. */
async function expectHostUnreachableAt(address: string): Promise<void> {
  await expect
    .poll(() =>
      fetch(`http://${address}/api/health`).then(
        () => "reachable",
        () => "unreachable",
      ),
    )
    .toBe("unreachable");
}

function tailscaleAddressRow(page: Page, address: string) {
  return page.getByTestId("devices-tailscale-address").filter({ hasText: address });
}

export async function disableTailscale(page: Page, address: string): Promise<void> {
  const toggle = page.getByRole("switch", { name: "Tailscale", exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(tailscaleAddressRow(page, address)).toHaveCount(0);
  await expectHostUnreachableAt(address);
}

/** Reopens the host over its Tailscale address, as a phone on the tailnet would reach it. */
export async function connectThroughTailscale(
  page: Page,
  daemon: { serverId: string; tailscaleAddress: string },
): Promise<void> {
  await preparePairingHost(page, { serverId: daemon.serverId, endpoint: daemon.tailscaleAddress });
  await expectTailscaleAddress(page, daemon.tailscaleAddress);
}

const TURN_OFF_QUESTION =
  "Turn off Tailscale?\n\nThis device is connected through Tailscale and will lose its connection to the host.";

/**
 * Taps the switch off over the Tailscale connection and cancels the question. Every state the row
 * commits from the tap to after Cancel must still show Tailscale on with its address: nothing
 * changes until the user confirms.
 */
export async function cancelTailscaleTurnOff(page: Page, address: string): Promise<void> {
  const row = await recordTailscaleRow(page);
  const question = answerNextDialog(page, "dismiss");
  await page.getByRole("switch", { name: "Tailscale", exact: true }).click();
  expect(await question).toBe(TURN_OFF_QUESTION);
  await page.waitForTimeout(500);
  expect(new Set((await row()).map((state) => `${state.value} ${state.address}`))).toEqual(
    new Set(["on true"]),
  );
  await expect(page.getByRole("switch", { name: "Tailscale", exact: true })).toBeChecked();
  await expect(tailscaleAddressRow(page, address)).toBeVisible();
  expect((await fetch(`http://${address}/api/health`)).ok).toBe(true);
}

/**
 * Confirms turning Tailscale off over the Tailscale connection, which cuts this app off the host.
 * Without the host the row shows no value at all, on or off.
 */
export async function confirmTailscaleTurnOff(page: Page, address: string): Promise<void> {
  const question = answerNextDialog(page, "accept");
  await page.getByRole("switch", { name: "Tailscale", exact: true }).click();
  expect(await question).toBe(TURN_OFF_QUESTION);
  await expect(page.getByText("Host is not connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Tailscale", exact: true })).toHaveCount(0);
  await expectHostUnreachableAt(address);
}

function answerNextDialog(page: Page, answer: "accept" | "dismiss"): Promise<string> {
  return new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await (answer === "accept" ? dialog.accept() : dialog.dismiss());
    });
  });
}

interface TailscaleRowState {
  /** `none` while the row shows no value yet. */
  value: "on" | "off" | "none";
  address: boolean;
  hint: string;
  labelTop: number;
  hintTop: number;
}

/**
 * Records every state the Tailscale row commits, painted or not: from now on in this page, and
 * from the first paint of every page load after it. Recording again starts a new record.
 */
async function recordTailscaleRow(page: Page): Promise<() => Promise<TailscaleRowState[]>> {
  const record = () => {
    const host = window as unknown as {
      tailscaleRow?: { states: unknown[]; last: string; sample(): void };
    };
    if (host.tailscaleRow) {
      host.tailscaleRow.states = [];
      host.tailscaleRow.last = "";
      host.tailscaleRow.sample();
      return;
    }
    const isVisibleText = (element: Element, text?: string) =>
      element.childElementCount === 0 &&
      (text === undefined
        ? (element.textContent ?? "").trim() !== ""
        : element.textContent === text) &&
      element.getBoundingClientRect().height > 0;
    const readValue = (toggle: Element | null) => {
      if (!toggle) return "none";
      return toggle.getAttribute("aria-checked") === "true" ? "on" : "off";
    };
    const read = () => {
      const label = [...document.querySelectorAll("div, span")].find((element) =>
        isVisibleText(element, "Tailscale"),
      );
      if (!label) return null;
      let row: Element = label;
      while (row.parentElement && !(row as HTMLElement).innerText.includes("\n")) {
        row = row.parentElement;
      }
      const hint = [...row.querySelectorAll("div, span")].find(
        (element) => element !== label && isVisibleText(element),
      );
      const toggle = document.querySelector('[role="switch"][aria-label="Tailscale"]');
      return {
        value: readValue(toggle),
        address: document.querySelector('[data-testid="devices-tailscale-address"]') !== null,
        hint: hint?.textContent ?? "",
        labelTop: Math.round(label.getBoundingClientRect().top),
        hintTop: Math.round(hint?.getBoundingClientRect().top ?? -1),
      };
    };
    const recorder = {
      states: [] as unknown[],
      last: "",
      sample() {
        const state = read();
        const key = JSON.stringify(state);
        if (state && key !== recorder.last) recorder.states.push(state);
        recorder.last = key;
      },
    };
    host.tailscaleRow = recorder;
    new MutationObserver(() => recorder.sample()).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  };
  await page.addInitScript(record);
  await page.evaluate(record);
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { tailscaleRow: { states: TailscaleRowState[] } }).tailscaleRow
          .states,
    );
}

/**
 * Runs `open`, which first shows the Tailscale row of a host with Tailscale on, and checks the row
 * from its first state to its last: it starts with no value, never shows Tailscale off, and its
 * label and hint keep their text and place until it settles on, with the address below.
 */
export async function expectTailscaleRowLoadsOn(
  page: Page,
  address: string,
  open: () => Promise<void>,
): Promise<void> {
  const row = await recordTailscaleRow(page);
  await open();
  await expect(page.getByRole("switch", { name: "Tailscale", exact: true })).toBeChecked();
  await expect(tailscaleAddressRow(page, address)).toBeVisible();
  const states = await row();
  expect(states[0]?.value).toBe("none");
  expect(states.filter((state) => state.value === "off")).toEqual([]);
  expect(
    new Set(states.map(({ hint, labelTop, hintTop }) => `${hint} ${labelTop} ${hintTop}`)).size,
  ).toBe(1);
  expect(states.at(-1)).toMatchObject({ value: "on", address: true });
}

/**
 * Holds every message between the app and the host on `port` for `ms` in each direction, as on a
 * slow network. The returned function brings the connection back to full speed.
 */
export async function slowConnectionToHost(
  page: Page,
  port: number,
  ms: number,
): Promise<() => void> {
  let delay = ms;
  await page.routeWebSocket(wsRoutePatternForPort(String(port)), (app) => {
    const host = app.connectToServer();
    app.onMessage(
      deliverInOrderAfter(
        () => delay,
        (message) => host.send(message),
      ),
    );
    host.onMessage(
      deliverInOrderAfter(
        () => delay,
        (message) => app.send(message),
      ),
    );
  });
  return () => {
    delay = 0;
  };
}

function deliverInOrderAfter(
  delay: () => number,
  deliver: (message: string | Buffer) => void,
): (message: string | Buffer) => void {
  const queue: { at: number; message: string | Buffer }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    while (queue[0] && queue[0].at <= Date.now()) deliver(queue.shift()!.message);
    if (queue[0]) timer = setTimeout(flush, queue[0].at - Date.now());
  };
  return (message) => {
    queue.push({ at: Math.max(Date.now() + delay(), queue.at(-1)?.at ?? 0), message });
    if (!timer) flush();
  };
}

export async function expectTailscaleUpdateRequired(page: Page): Promise<void> {
  await expect(page.getByRole("switch", { name: "Tailscale", exact: true })).toBeDisabled();
  await expect(page.getByText("Update this host to use Tailscale", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "How to update", exact: true })).toBeVisible();
}

export async function expectTailscaleUnavailable(page: Page): Promise<void> {
  await expect(page.getByRole("switch", { name: "Tailscale", exact: true })).toBeDisabled();
  await expect(
    page.getByText("Tailscale is not running on this host", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Get Tailscale", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
}

export async function refreshTailscaleAvailability(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
}

export async function expectTailscaleAvailable(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0, options);
  const toggle = page.getByRole("switch", { name: "Tailscale", exact: true });
  await expect(toggle).toBeEnabled(options);
  await expect(toggle).not.toBeChecked(options);
  await expect(
    page.getByText("Direct over your tailnet, enter an address", { exact: true }),
  ).toBeVisible(options);
}

/**
 * Tracks `daemon.get_status` frames on the host socket so Refresh tests can align right after a
 * 2-second poll and verify the button click itself sent a fresh status request.
 */
export function observeDaemonStatusPolling(page: Page, port: number) {
  let lastResponseAt = 0;
  let waitingForResponse: (() => void) | null = null;
  let waitingForRequest: (() => void) | null = null;
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`:${port}`)) return;
    socket.on("framesent", ({ payload }) => {
      const message = typeof payload === "string" ? payload : payload.toString();
      if (message.includes('"type":"daemon.get_status.request"')) {
        waitingForRequest?.();
        waitingForRequest = null;
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const message = typeof payload === "string" ? payload : payload.toString();
      if (message.includes('"type":"daemon.get_status.response"')) {
        lastResponseAt = Date.now();
        waitingForResponse?.();
        waitingForResponse = null;
      }
    });
  });

  return {
    async waitForFreshPollWindow(): Promise<void> {
      if (Date.now() - lastResponseAt < 250) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waitingForResponse = null;
          reject(new Error("Timed out waiting for daemon status poll"));
        }, 5_000);
        waitingForResponse = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
    waitForStatusRequest(timeoutMs = 1_000): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waitingForRequest = null;
          reject(new Error("Refresh did not send daemon.get_status.request"));
        }, timeoutMs);
        waitingForRequest = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}

export async function openPairDeviceModal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Relay", exact: true }).click();
  await expect(page.getByTestId("devices-relay-pairing")).toBeVisible();
}

export async function expectRelayConsent(page: Page): Promise<void> {
  const modal = page.getByTestId("devices-relay-pairing");
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
  await expect(page.getByTestId("devices-relay-pairing")).toHaveCount(0);
}

export async function enableRelayAndExpectOffer(page: Page): Promise<void> {
  const enableButton = page.getByRole("button", { name: "Enable relay", exact: true });
  await enableButton.click();
  await expect(page.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pairing link" })).toHaveValue(/#offer=/);
  await expect(page.getByText("Enable relay?", { exact: true })).toHaveCount(0);
}

export async function expectPairingOffer(page: Page): Promise<void> {
  await expect(page.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pairing link" })).toHaveValue(/#offer=/);
  await expect(
    page.getByRole("alert").filter({
      hasText: "Treat this pairing link like a password. Anyone with it can access this daemon.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable relay", exact: true })).toHaveCount(0);
}

export async function closePairDeviceModal(page: Page): Promise<void> {
  await page
    .getByTestId("devices-relay-pairing")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByTestId("devices-relay-pairing")).toHaveCount(0);
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
  const modal = page.getByTestId("devices-relay-pairing");
  await expect(modal.getByRole("alert")).toContainText(expectedError);
  await expect(modal.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await expect(modal.getByRole("textbox", { name: "Pairing link" })).toHaveCount(0);
}

export async function retryRelayAndExpectFailure(
  page: Page,
  expectedError = "Relay is controlled by a daemon launch override",
): Promise<void> {
  const modal = page.getByTestId("devices-relay-pairing");
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
  const modal = page.getByTestId("devices-relay-pairing");
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
  const modal = page.getByTestId("devices-relay-pairing");
  await expect(modal.getByRole("alert")).toContainText("Host is not connected");
  await expect(modal.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
}

export async function switchPairDeviceToHost(page: Page, serverId: string): Promise<void> {
  await selectSettingsHost(page, serverId);
  await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, "devices"));
  await expect(page.getByTestId("devices-relay")).toBeVisible();
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

export async function expectCompletePairingQr(page: Page): Promise<void> {
  const qr = page.getByRole("img", { name: "Pairing QR code" });
  await qr.scrollIntoViewIfNeeded();
  // IntersectionObserver rounds fractional sheet/scroll coordinates.
  await expect(qr).toBeInViewport({ ratio: 0.999 });
  const bounds = await qr.evaluate((element) => {
    const tile = element.parentElement;
    if (!tile) throw new Error("Pairing QR tile is missing");
    const qrRect = element.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    return {
      qr: { x: qrRect.x, y: qrRect.y, right: qrRect.right, bottom: qrRect.bottom },
      tile: { x: tileRect.x, y: tileRect.y, right: tileRect.right, bottom: tileRect.bottom },
    };
  });
  expect(bounds.qr.x).toBeGreaterThanOrEqual(bounds.tile.x);
  expect(bounds.qr.y).toBeGreaterThanOrEqual(bounds.tile.y);
  expect(bounds.qr.right).toBeLessThanOrEqual(bounds.tile.right);
  expect(bounds.qr.bottom).toBeLessThanOrEqual(bounds.tile.bottom);
}
