import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "../fixtures";
import type { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { daemonWsRoutePattern } from "./daemon-port";
import { getServerId } from "./server-id";
import { expectWorkspaceAbsentFromSidebar } from "./sidebar";

type DaemonClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

const UNDO_SHORTCUT = process.platform === "darwin" ? "Meta+Z" : "Control+Z";
const ARCHIVE_SHORTCUT =
  process.platform === "darwin" ? "Meta+Shift+Backspace" : "Control+Shift+Backspace";
/** The archived toast's lifetime, from `WORKSPACE_ARCHIVE_UNDO_WINDOW_MS`. */
const UNDO_WINDOW_MS = 6000;

export function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

export function rowArchiveButton(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-archive-button-${getServerId()}:${workspaceId}`);
}

export function rowKebab(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${workspaceId}`);
}

export function undoButton(page: Page) {
  return page.getByRole("button", { name: /^Undo/ });
}

export async function workspaceTitleWidth(page: Page, workspaceId: string): Promise<number> {
  const box = await page
    .getByTestId(`sidebar-workspace-title-${getServerId()}:${workspaceId}`)
    .boundingBox();
  if (!box) throw new Error(`Title of ${workspaceId} is not laid out`);
  return box.width;
}

/** Archives a workspace with its row's hover button and waits for the undo toast. */
export async function archiveFromRowButton(page: Page, workspaceId: string): Promise<void> {
  page.once("dialog", (dialog) => void dialog.accept());
  await workspaceRow(page, workspaceId).hover();
  await rowArchiveButton(page, workspaceId).click();
  await expectWorkspaceAbsentFromSidebar(page, workspaceId);
  await expect(undoButton(page)).toBeVisible();
}

/** Drags the sidebar's edge past its minimum, leaving it as narrow as it goes. */
export async function resizeSidebarToMinimum(page: Page): Promise<void> {
  const handle = await page.getByTestId("left-sidebar-resize-handle").boundingBox();
  if (!handle) throw new Error("Sidebar resize handle is not laid out");
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(handle.x - 30, y, { steps: 8 });
  await page.mouse.move(10, y, { steps: 16 });
  await page.mouse.up();
  await expect
    .poll(async () => (await page.getByTestId("sidebar-footer").boundingBox())?.width)
    .toBeLessThanOrEqual(200);
}

export async function pressArchiveShortcut(page: Page): Promise<void> {
  await page.keyboard.press(ARCHIVE_SHORTCUT);
}

export async function pressUndoShortcut(page: Page): Promise<void> {
  await page.keyboard.press(UNDO_SHORTCUT);
}

/** Moves the page clock past the moment an unheld archived toast would have closed. */
export async function outlastUndoWindow(page: Page): Promise<void> {
  await page.clock.fastForward(UNDO_WINDOW_MS + 1000);
}

/** Waits until the host lists the workspace as active with no archive running on it. */
export async function expectHostWorkspaceSettledActive(
  client: DaemonClient,
  workspaceId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { entries } = await client.fetchWorkspaces();
        const entry = entries.find((candidate) => candidate.id === workspaceId);
        return entry ? { active: true, archiving: Boolean(entry.archivingAt) } : null;
      },
      { timeout: 30_000 },
    )
    .toEqual({ active: true, archiving: false });
}

export async function expectDirectoryPresence(directory: string, present: boolean): Promise<void> {
  await expect.poll(() => existsSync(directory), { timeout: 30_000 }).toBe(present);
}

export interface HeldArchiveRequest {
  waitForHeld(): Promise<void>;
  /** Sends the held request to the daemon naming a workspace it has no record of, so it refuses. */
  releaseForUnknownWorkspace(workspaceId: string): void;
}

/** Keeps the next archive request from reaching the daemon until the test releases it. */
export async function holdNextArchiveRequest(page: Page): Promise<HeldArchiveRequest> {
  let held: { request: SessionRequest; forward: (raw: string) => void } | null = null;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const request = parseSessionRequest(message);
      if (!held && request?.type === "archive_workspace_request") {
        held = { request, forward: (raw) => server.send(raw) };
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  return {
    waitForHeld: () => expect.poll(() => held !== null).toBe(true),
    releaseForUnknownWorkspace: (workspaceId) => {
      if (!held) throw new Error("No archive request is held");
      held.forward(JSON.stringify({ type: "session", message: { ...held.request, workspaceId } }));
    },
  };
}

interface SessionRequest {
  type: string;
  requestId: string;
  workspaceId: string;
}

function parseSessionRequest(message: string | Buffer): SessionRequest | null {
  try {
    const envelope = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
    return envelope?.type === "session" ? envelope.message : null;
  } catch {
    return null;
  }
}

export interface GatedTeardown {
  /** The `paseo.json` config whose worktree teardown parks until released. */
  paseoConfig: Record<string, unknown>;
  expectStarted(): Promise<void>;
  release(): void;
}

/** A worktree teardown that parks an archive mid-flight, so an undo lands while it runs. */
export function createGatedTeardown(): GatedTeardown {
  const gateDir = mkdtempSync(path.join(tmpdir(), "archive-undo-gate-"));
  const startedPath = path.join(gateDir, "started");
  const releasePath = path.join(gateDir, "release");
  const teardown = `node -e "const fs=require('fs');fs.writeFileSync('${startedPath}','started');const timer=setInterval(()=>{if(fs.existsSync('${releasePath}'))clearInterval(timer)},20)"`;
  return {
    paseoConfig: { worktree: { teardown: [teardown] } },
    expectStarted: () => expectDirectoryPresence(startedPath, true),
    release: () => writeFileSync(releasePath, "release\n"),
  };
}
