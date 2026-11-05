import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import { addProjectFlow, addProjectFlowInput, chooseAddProjectMethod } from "./add-project-flow";
import { connectDaemonClient } from "./daemon-client-loader";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";
import { startIsolatedHostDaemon, type IsolatedHostDaemonOptions } from "./isolated-host-daemon";

/** Points a fresh browser profile at one host, with no first-run record and no app settings. */
export async function openAppAsNewUser(
  page: Page,
  host: { serverId: string; port: number },
): Promise<void> {
  const seededHost = buildSeededHost({
    serverId: host.serverId,
    endpoint: `127.0.0.1:${host.port}`,
    nowIso: new Date().toISOString(),
  });
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, async (webSocket) => {
    await webSocket.close({ code: 1008, reason: "Blocked developer daemon during e2e." });
  });
  await page.addInitScript(
    ({ registryHost, preferences }) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([registryHost]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
    },
    { registryHost: seededHost, preferences: buildCreateAgentPreferences() },
  );
  await page.goto("/");
}

interface FirstLaunchRecord {
  appBeforeSetup: boolean;
  setupOpacityOnArrival: number | null;
}

/**
 * Watches the page from its first paint: whether the app's sidebar or home showed before setup,
 * and how opaque setup was when it arrived. Call before `openAppAsNewUser`.
 */
export async function recordFirstLaunch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record: FirstLaunchRecord = { appBeforeSetup: false, setupOpacityOnArrival: null };
    Object.assign(window, { __firstLaunch: record });
    const observer = new MutationObserver(() => {
      const setup = document.querySelector('[data-testid="onboarding-modal"] [role="dialog"]');
      if (setup) {
        record.setupOpacityOnArrival = Number(getComputedStyle(setup).opacity);
        observer.disconnect();
        return;
      }
      if (
        document.querySelector(
          '[data-testid="open-project-submit"], [data-testid="sidebar-settings"]',
        )
      ) {
        record.appBeforeSetup = true;
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

export async function readFirstLaunch(page: Page): Promise<FirstLaunchRecord> {
  return page.evaluate(
    () => (window as unknown as { __firstLaunch: FirstLaunchRecord }).__firstLaunch,
  );
}

/** The loading screen the app shows while it starts. */
export function loadingScreen(page: Page): Locator {
  return page.getByTestId("startup-splash");
}

/** The empty home a host with no projects lands on. */
export function emptyHome(page: Page): Locator {
  return page.getByTestId("open-project-submit");
}

export function setupModal(page: Page): Locator {
  return page.getByTestId("onboarding-modal").getByRole("dialog");
}

export async function expectSetupStep(page: Page, title: string): Promise<void> {
  await expect(setupModal(page).getByRole("heading", { name: title, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

export async function pickTheme(page: Page, name: string): Promise<void> {
  const tile = setupModal(page).getByRole("radio", { name, exact: true });
  await tile.click();
  await expect(tile).toBeChecked();
}

export async function continueSetup(page: Page): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Continue", exact: true }).click();
}

export async function skipSetup(page: Page): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Skip setup", exact: true }).click();
  await expect(setupModal(page)).toHaveCount(0);
}

/** Adds a folder through the regular Add project flow, opened from the setup's Projects step. */
export async function addProjectFromSetup(page: Page, projectPath: string): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Add project", exact: true }).click();
  await expect(addProjectFlow(page)).toBeVisible({ timeout: 30_000 });
  await chooseAddProjectMethod(page, "directory-search");
  await addProjectFlowInput(page).fill(projectPath);
  await page.keyboard.press("Enter");
  await expect(addProjectFlow(page)).toHaveCount(0, { timeout: 30_000 });
}

export async function showSetupAgainFromSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-settings"]:visible').first().click();
  await page.getByRole("button", { name: "Show setup again", exact: true }).click();
}

export async function goToSetupStep(page: Page, label: string): Promise<void> {
  await setupModal(page).getByRole("tab", { name: label, exact: true }).click();
}

export function paseoToolsSwitch(scope: Page | Locator): Locator {
  return scope.getByRole("switch", { name: "Inject Paseo tools", exact: true });
}

/** Whether the host gives its agents Paseo tools, read from the host itself. */
export async function hostGivesAgentsPaseoTools(host: { port: number }): Promise<boolean> {
  const client = await connectDaemonClient<
    Pick<InternalDaemonClient, "connect" | "close" | "getDaemonConfig">
  >({ clientIdPrefix: "app-e2e-onboarding", port: host.port });
  try {
    return (await client.getDaemonConfig()).config.mcp.injectIntoAgents !== false;
  } finally {
    await client.close();
  }
}

export async function finishSetup(page: Page): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Finish", exact: true }).click();
  await expect(setupModal(page)).toHaveCount(0);
}

/** Opens the Phone step's Relay row: the pair device modal, over setup. */
export async function openRelayPairingFromSetup(page: Page): Promise<Locator> {
  await setupModal(page).getByRole("button", { name: "Relay", exact: true }).click();
  const pairing = page.getByTestId("onboarding-pair-device-card");
  await expect(pairing).toBeVisible();
  return pairing;
}

export async function closeRelayPairing(pairing: Locator): Promise<void> {
  await pairing.getByRole("button", { name: "Close", exact: true }).click();
  await expect(pairing).toHaveCount(0);
}

/** Clicks the Phone step's Tailscale row and returns the docs page it opened. */
export async function openTailscaleDocsFromSetup(page: Page): Promise<string> {
  await page
    .context()
    .route("https://paseo.sh/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Paseo docs</title>" }),
    );
  const popup = page.waitForEvent("popup");
  await setupModal(page).getByRole("link", { name: "Tailscale, Docs", exact: true }).click();
  const docs = await popup;
  await docs.waitForLoadState("domcontentloaded");
  const url = docs.url();
  await docs.close();
  return url;
}

export interface SetupHost {
  serverId: string;
  port: number;
  close(): Promise<void>;
}

/**
 * An isolated host whose only agent history is the Claude sessions given here, so suggestions
 * never depend on the machine running the test. Its HOME is a scratch folder, so the skills setup
 * installs never land in the real ~/.agents, ~/.claude or ~/.codex. `withBrokenProvider` adds a
 * provider that cannot start.
 */
export async function startSetupHost(
  label: string,
  options: {
    claudeSessionsIn?: readonly string[];
    withBrokenProvider?: boolean;
    mutableRelay?: IsolatedHostDaemonOptions["mutableRelay"];
  } = {},
): Promise<SetupHost> {
  const serverId = `srv_onboarding_${label}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const claudeConfigDir = await seedClaudeHistory(options.claudeSessionsIn ?? []);
  const home = await mkdtemp(path.join(tmpdir(), "paseo-onboarding-home-"));
  const daemon = await startIsolatedHostDaemon(serverId, {
    config: claudeOnlyConfig({ withBrokenProvider: options.withBrokenProvider ?? false }),
    environment: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir },
    mutableRelay: options.mutableRelay,
  });
  return {
    serverId,
    port: daemon.port,
    close: async () => {
      await daemon.close();
      await rm(claudeConfigDir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Writes one recent Claude session per folder into a fresh CLAUDE_CONFIG_DIR. */
async function seedClaudeHistory(cwds: readonly string[]): Promise<string> {
  const configDir = await mkdtemp(path.join(tmpdir(), "paseo-onboarding-claude-"));
  const newest = Date.now() - 60_000;
  for (const [index, cwd] of cwds.entries()) {
    const sessionId = `onboarding-session-${index + 1}`;
    const projectDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
    const record = {
      type: "user",
      uuid: `${sessionId}-user`,
      message: { role: "user", content: `Work on session ${index + 1}` },
      cwd,
      sessionId,
    };
    await writeFile(sessionPath, `${JSON.stringify(record)}\n`);
    const timestamp = new Date(newest - index * 60_000);
    await utimes(sessionPath, timestamp, timestamp);
  }
  return configDir;
}

function claudeOnlyConfig(options: { withBrokenProvider: boolean }) {
  const brokenProvider = {
    "broken-acp": {
      extends: "acp",
      label: "Broken ACP",
      command: ["missing-agent-command", "acp"],
    },
  };
  return {
    agents: {
      providers: {
        codex: { enabled: false },
        copilot: { enabled: false },
        omp: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        ...(options.withBrokenProvider ? brokenProvider : {}),
      },
    },
  };
}

/** The switch that picks a suggested project for adding. */
export function projectSuggestion(page: Page, name: string): Locator {
  return setupModal(page).getByRole("switch", { name, exact: true });
}

/** The whole suggestion row, with its path, last use and any add error beside the switch. */
export function projectSuggestionRow(page: Page, name: string): Locator {
  return setupModal(page)
    .getByTestId("project-suggestion")
    .filter({ has: page.getByRole("switch", { name, exact: true }) });
}

/** The footer's main button, which adds the checked suggestions when there are any. */
export function setupPrimaryButton(page: Page, label: string): Locator {
  return setupModal(page).getByRole("button", { name: label, exact: true });
}
