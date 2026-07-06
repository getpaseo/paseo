import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import { gotoAppShell, openSettings } from "./app";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

function parseWebSocketJson(message: WebSocketMessage): unknown {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseWebSocketJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

// --- Navigation ---

export async function openProjects(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await page.getByTestId("settings-projects").click();
  await expect(page).toHaveURL(/\/settings\/projects$/);
}

export async function openProjectSettings(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Edit ${projectName}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toBeVisible({
    timeout: 30_000,
  });
}

export async function navigateToProjectSettings(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Edit ${projectName}`, exact: true }).click();
}

// --- Form interactions ---

export async function editWorktreeSetup(page: Page, setupCommands: string[]): Promise<void> {
  await page
    .getByRole("textbox", { name: "Worktree setup commands" })
    .fill(setupCommands.join("\n"));
}

export async function clickSaveProjectSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save" }).click();
}

export async function clickRetryProjectSettingsSave(page: Page): Promise<void> {
  // action-0 is always "Try again"; action-1 is always "Reload".
  // The write-failed callout renders these two buttons in a fixed order.
  await page.getByTestId("write-failed-callout-action-0").click();
}

export async function clickReloadProjectSettings(page: Page): Promise<void> {
  // Scope to the active error callout so the locator is unambiguous.
  // At most one error callout renders at a time.
  await page.locator('[data-testid$="-callout"]').getByRole("button", { name: "Reload" }).click();
}

// --- Error-state assertions ---

type ErrorKind = "stale" | "invalid" | "write_failed" | "transport" | "read_failed";

const errorCalloutTestId: Record<ErrorKind, string> = {
  stale: "stale-callout",
  invalid: "invalid-callout",
  write_failed: "write-failed-callout",
  transport: "read-transport-callout",
  read_failed: "read-failed-callout",
};

export async function expectProjectSettingsError(page: Page, kind: ErrorKind): Promise<void> {
  await expect(page.getByTestId(errorCalloutTestId[kind])).toBeVisible({ timeout: 15_000 });
}

export async function expectNoProjectSettingsError(
  page: Page,
  kind: ErrorKind,
  timeout = 15_000,
): Promise<void> {
  await expect(page.getByTestId(errorCalloutTestId[kind])).not.toBeVisible({ timeout });
}

export async function expectWriteFailedCalloutActions(page: Page): Promise<void> {
  await expect(page.getByTestId("write-failed-callout-action-0")).toHaveText("Try again");
  await expect(page.getByTestId("write-failed-callout-action-1")).toHaveText("Reload");
}

export async function expectSaveButtonDisabled(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
}

// --- Form-state assertions ---

export async function expectProjectSettingsFormVisible(page: Page): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toBeVisible({
    timeout: 15_000,
  });
}

export async function expectProjectSettingsFormHidden(page: Page): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).not.toBeVisible();
}

export async function expectNoEditableTarget(page: Page): Promise<void> {
  await expect(page.getByTestId("project-settings-back-button")).toBeVisible({ timeout: 30_000 });
}

// --- Host-section assertions ---

export async function expectHostIndicatorVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("host-indicator")).toBeVisible();
}

export async function expectHostPickerHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("host-picker")).not.toBeVisible();
}

// --- Script-list assertions and interactions ---

// Counts only row Views, not kebab-trigger elements (which share the "script-row-"
// prefix but contain "-menu-").
export async function expectScriptRowCount(page: Page, count: number): Promise<void> {
  await expect(
    page
      .getByTestId("scripts-list")
      .locator('[data-testid^="script-row-"]:not([data-testid*="-menu-"])'),
  ).toHaveCount(count);
}

export async function expectEmptyScriptList(page: Page): Promise<void> {
  await expect(page.getByText("No scripts yet.")).toBeVisible();
}

export async function removeProjectScript(page: Page, scriptName: string): Promise<void> {
  const row = page
    .getByTestId("scripts-list")
    .locator('[data-testid^="script-row-"]:not([data-testid*="-menu-"])')
    .filter({ hasText: scriptName })
    .first();
  // DropdownMenuTrigger renders as a Pressable (no role="button"); derive its testID
  // from the row's testID to avoid scoped locator unreliability.
  const id = (await row.getAttribute("data-testid"))!.replace("script-row-", "");
  await page.getByTestId(`script-row-menu-${id}`).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove" }).click();
}

// --- File manipulation ---

export async function corruptPaseoConfig(repoPath: string): Promise<void> {
  await writeFile(path.join(repoPath, "paseo.json"), "{not valid json}");
}

export async function bumpPaseoConfigOnDisk(repoPath: string): Promise<void> {
  const configPath = path.join(repoPath, "paseo.json");
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  config._bump = Date.now();
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export async function restorePaseoConfig(
  repoPath: string,
  config: Record<string, unknown>,
): Promise<void> {
  await writeFile(path.join(repoPath, "paseo.json"), JSON.stringify(config, null, 2) + "\n");
}

// The daemon writes atomically via a temp file + rename, so blocking writes requires
// removing write permission from the *directory*, not just the file.
export async function blockPaseoConfigWrites(repoPath: string): Promise<void> {
  await chmod(repoPath, 0o555);
}

export async function unblockPaseoConfigWrites(repoPath: string): Promise<void> {
  await chmod(repoPath, 0o755);
}

// --- WebSocket helpers ---

// Proxies all daemon WS traffic transparently, but rejects paseo.json reads
// until the test explicitly allows recovery. Closing the transport leaves the
// client-side RPC pending across reconnects, so this injects the same correlated
// rpc_error shape the daemon emits for failed async session requests.
export async function installReadTransportFailure(
  page: Page,
): Promise<{ allowRecovery: () => void }> {
  let shouldFailReads = true;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (shouldFailReads && sessionMessage?.type === "read_project_config_request") {
        const requestId = sessionMessage.requestId;
        if (typeof requestId === "string") {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId,
                  requestType: "read_project_config_request",
                  error: "Test read transport failure.",
                  code: "transport",
                },
              },
            }),
          );
        }
        return;
      }
      try {
        server.send(message);
      } catch {
        // server socket already closed
      }
    });

    server.onMessage((message) => {
      try {
        ws.send(message);
      } catch {
        // client socket already closed
      }
    });
  });

  return {
    allowRecovery() {
      shouldFailReads = false;
    },
  };
}

// Installs a transparent WS proxy that can later drop all active daemon connections
// and block new ones. Code 1001 (Going Away) without reason triggers "error" state
// in DaemonClient due to describeTransportClose returning a non-empty string.
export async function installDaemonConnectionGate(
  page: Page,
): Promise<{ drop: () => Promise<void> }> {
  let acceptingConnections = true;
  const activeSockets = new Set<WebSocketRoute>();

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    if (!acceptingConnections) {
      void ws.close({ code: 1001 });
      return;
    }

    activeSockets.add(ws);
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      if (!acceptingConnections) return;
      try {
        server.send(message);
      } catch {
        activeSockets.delete(ws);
      }
    });

    server.onMessage((message) => {
      if (!acceptingConnections) return;
      try {
        ws.send(message);
      } catch {
        activeSockets.delete(ws);
      }
    });
  });

  return {
    async drop(): Promise<void> {
      acceptingConnections = false;
      const sockets = Array.from(activeSockets);
      activeSockets.clear();
      await Promise.all(sockets.map((ws) => ws.close({ code: 1001 }).catch(() => undefined)));
    },
  };
}
