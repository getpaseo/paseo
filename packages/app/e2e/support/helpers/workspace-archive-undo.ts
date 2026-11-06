import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect } from "../fixtures";
import type { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { getServerId } from "./server-id";
import { expectWorkspaceAbsentFromSidebar } from "./sidebar";

type DaemonClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

const UNDO_SHORTCUT = process.platform === "darwin" ? "Meta+Z" : "Control+Z";
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
