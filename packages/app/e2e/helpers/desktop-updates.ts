import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { openSettings } from "./app";
import { openSettingsHost } from "./settings";

interface DaemonApiStatus {
  version: string;
  serverId: string;
  hostname: string;
}

interface PidFileContent {
  pid: number;
  desktopManaged: boolean;
}

export interface RealDaemonState {
  version: string;
  pid: number | null;
  logPath: string;
}

/**
 * Reads live state from the running E2E test daemon: version from the HTTP
 * status endpoint, PID from the paseo.pid lock file, log path from the
 * E2E_PASEO_HOME directory. Call this in Node test code (not in the browser).
 */
export async function loadRealDaemonState(): Promise<RealDaemonState> {
  const port = process.env.E2E_DAEMON_PORT;
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!port) throw new Error("E2E_DAEMON_PORT not set — globalSetup must run first");
  if (!paseoHome) throw new Error("E2E_PASEO_HOME not set — globalSetup must run first");

  const resp = await fetch(`http://127.0.0.1:${port}/api/status`);
  const data: DaemonApiStatus = await resp.json();

  let pid: number | null = null;
  try {
    const raw = readFileSync(`${paseoHome}/paseo.pid`, "utf8");
    const pidContent: PidFileContent = JSON.parse(raw);
    pid = pidContent.pid ?? null;
  } catch (err) {
    // PID file may not be present yet on a very fresh daemon start
    console.warn("[desktop-updates] paseo.pid not found:", err);
  }

  return { version: data.version, pid, logPath: `${paseoHome}/daemon.log` };
}

export interface DesktopBridgeConfig {
  serverId: string;
  updateAvailable?: boolean;
  latestVersion?: string;
  slowInstall?: boolean;
  /** Initial PID reported by desktop_daemon_status. Defaults to null. */
  daemonPid?: number | null;
  daemonVersion?: string | null;
  daemonLogPath?: string;
  /** Initial manageBuiltInDaemon setting. Defaults to false. */
  manageBuiltInDaemon?: boolean;
  /**
   * Controls what dialog.ask returns when the daemon management confirm dialog
   * fires. True = confirm (proceed with the action), false = cancel. Defaults to
   * false so tests that only assert copy don't inadvertently trigger state changes.
   */
  confirmShouldAccept?: boolean;
}

export interface ConfirmDialogCall {
  message: string;
  title: string | undefined;
}

declare global {
  interface Window {
    __capturedDialogCall: ConfirmDialogCall | undefined;
  }
}

/**
 * Injects window.paseoDesktop before app load so all Electron-gated code
 * activates. The update-check IPC is mocked at the boundary so the real
 * auto-updater never fires. Daemon start/stop commands are stateful: the mock
 * tracks running state and assigns a fresh PID on each start, letting tests
 * observe PID changes without touching the real E2E daemon process.
 * dialog.ask captures call arguments on window.__capturedDialogCall so tests
 * can assert dialog copy without depending on window.confirm concatenation.
 */
export async function injectDesktopBridge(page: Page, config: DesktopBridgeConfig): Promise<void> {
  await page.addInitScript((cfg) => {
    // Mutable state shared across IPC calls within this page
    let manageDaemon = cfg.manageBuiltInDaemon ?? false;
    let daemonRunning = true;
    let currentPid: number | null = cfg.daemonPid ?? null;
    let startCount = 0;

    function buildDaemonStatus() {
      return {
        serverId: cfg.serverId,
        status: daemonRunning ? "running" : "stopped",
        listen: null,
        hostname: null,
        pid: currentPid,
        home: "",
        version: cfg.daemonVersion ?? null,
        desktopManaged: manageDaemon,
        error: null,
      };
    }

    (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
      platform: "darwin",
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === "check_app_update") {
          return cfg.updateAvailable
            ? {
                hasUpdate: true,
                readyToInstall: true,
                currentVersion: "1.0.0",
                latestVersion: cfg.latestVersion ?? "1.2.3",
                body: null,
                date: null,
              }
            : {
                hasUpdate: false,
                readyToInstall: false,
                currentVersion: "1.0.0",
                latestVersion: null,
                body: null,
                date: null,
              };
        }

        if (command === "install_app_update") {
          if (cfg.slowInstall) {
            await new Promise<void>((resolve) => setTimeout(resolve, 3000));
          }
          return {
            installed: true,
            version: cfg.latestVersion ?? "1.2.3",
            message: "App update installed. Restart required.",
          };
        }

        if (command === "desktop_daemon_status") {
          return buildDaemonStatus();
        }

        if (command === "desktop_daemon_logs") {
          return { logPath: cfg.daemonLogPath ?? "", contents: "" };
        }

        if (command === "get_desktop_settings") {
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: manageDaemon, keepRunningAfterQuit: true },
          };
        }

        if (command === "patch_desktop_settings") {
          const daemon = args?.daemon;
          if (
            daemon !== null &&
            typeof daemon === "object" &&
            "manageBuiltInDaemon" in daemon &&
            typeof daemon.manageBuiltInDaemon === "boolean"
          ) {
            manageDaemon = daemon.manageBuiltInDaemon;
          }
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: manageDaemon, keepRunningAfterQuit: true },
          };
        }

        if (command === "stop_desktop_daemon") {
          daemonRunning = false;
          currentPid = null;
          return buildDaemonStatus();
        }

        if (command === "start_desktop_daemon") {
          startCount += 1;
          daemonRunning = true;
          // First start (bootstrap) returns the configured PID; subsequent starts
          // (after a stop) get a fresh PID so tests can observe the change.
          currentPid = (cfg.daemonPid ?? 10000) + (startCount - 1) * 1000;
          return buildDaemonStatus();
        }

        return null;
      },
      dialog: {
        ask: async (message: string, options?: Record<string, unknown>) => {
          window.__capturedDialogCall = {
            message,
            title: typeof options?.title === "string" ? options.title : undefined,
          };
          return cfg.confirmShouldAccept ?? false;
        },
      },
      getPendingOpenProject: async () => null,
      events: { on: async () => () => undefined },
    };
  }, config);
}

export async function openDesktopSettings(page: Page, serverId: string): Promise<void> {
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await expect(page.getByTestId("host-page-daemon-lifecycle-card")).toBeVisible({
    timeout: 15_000,
  });
}

export async function expectUpdateBanner(page: Page, version: string): Promise<void> {
  const callout = page.getByTestId("update-callout");
  await expect(callout).toBeVisible({ timeout: 15_000 });
  await expect(callout).toContainText(`v${version.replace(/^v/i, "")}`);
}

export async function clickInstallUpdate(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Install & restart" }).click();
}

export async function expectInstallInProgress(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Installing..." })).toBeVisible();
}

/**
 * Clicks the daemon management switch and waits for dialog.ask to fire in the
 * mock, then returns the captured call args (message + title). The mock auto-
 * dismisses via confirmShouldAccept=false so callers can assert copy without
 * worrying about state changes.
 */
export async function interceptDaemonManagementConfirmDialog(
  page: Page,
): Promise<ConfirmDialogCall> {
  await page.getByRole("switch", { name: "Manage built-in daemon" }).click();
  await page.waitForFunction(() => !!window.__capturedDialogCall, { timeout: 5_000 });
  return page.evaluate(() => window.__capturedDialogCall!);
}

export async function toggleDaemonManagement(
  page: Page,
  _action: "enable" | "disable",
): Promise<void> {
  await page.getByRole("switch", { name: "Manage built-in daemon" }).click();
}

export function expectDaemonManagementConfirmDialog(args: ConfirmDialogCall): void {
  expect(args.title).toBe("Pause built-in daemon");
  expect(args.message).toContain("stop the built-in daemon immediately");
}

export async function expectDaemonManagementEnabled(page: Page): Promise<void> {
  await expect(page.getByRole("switch", { name: "Manage built-in daemon" })).toBeChecked();
}

export async function expectDaemonManagementDisabled(page: Page): Promise<void> {
  await expect(page.getByRole("switch", { name: "Manage built-in daemon" })).not.toBeChecked();
}

/**
 * Asserts the daemon status card shows the given PID. Pass null to assert
 * the cleared state (shown as "PID —" when the daemon is stopped).
 */
export async function expectDaemonStatusPid(page: Page, pid: number | null): Promise<void> {
  const expected = pid !== null ? `PID ${pid}` : "PID —";
  await expect(
    page.getByTestId("host-page-daemon-lifecycle-card").getByText(expected),
  ).toBeVisible();
}

export async function expectDaemonStatusLogPath(page: Page, logPath: string): Promise<void> {
  await expect(
    page.getByTestId("host-page-daemon-lifecycle-card").getByText(logPath),
  ).toBeVisible();
}

/**
 * Asserts the host page identity badge shows the given version string.
 * The badge is populated from the live WebSocket session's serverInfo.version.
 */
export async function expectDaemonStatusVersion(page: Page, version: string): Promise<void> {
  await expect(
    page.getByTestId("host-page-identity").getByText(version, { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
}
