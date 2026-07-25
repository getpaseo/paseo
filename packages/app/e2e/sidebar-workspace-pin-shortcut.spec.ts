import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { daemonWsRoutePattern } from "./helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

// The pin shortcut used to be registered by the sidebar row itself, so it silently did nothing
// whenever the row was unmounted — a collapsed project section being the common case. It now
// lives in a single always-mounted handler keyed on the active route selection.
const PIN_SHORTCUT = "ControlOrMeta+Shift+P";

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function pinnedSection(page: Page) {
  return page.getByTestId("sidebar-pinned-section");
}

// Opens the workspace so it becomes the active route selection, which is what the shortcut acts on.
async function openWorkspace(page: Page, workspaceId: string) {
  const row = workspaceRow(page, workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
}

// The project key is host-scoped and not exposed by the seed helper, so the header is addressed by
// its display name, scoped to project rows so a workspace row can never match. Pressing the header
// toggles the section, which unmounts every workspace row under it.
async function collapseProjectSection(page: Page, project: SeededWorkspace): Promise<void> {
  const header = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: project.projectDisplayName });
  await expect(header).toHaveCount(1, { timeout: 30_000 });

  await header.click();
  await expect(workspaceRow(page, project.workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

async function switchToStatusGrouping(page: Page): Promise<void> {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await page.getByTestId("sidebar-grouping-status").click();
  await expect(page.getByTestId("sidebar-status-list-scroll")).toBeVisible({ timeout: 10_000 });
}

// Status mode buckets workspaces by state rather than project, so the group holding this workspace
// is discovered from the rows container it sits in rather than assumed.
async function collapseStatusGroupContaining(page: Page, workspaceId: string): Promise<void> {
  const rows = page
    .locator('[data-testid^="sidebar-status-group-rows-"]')
    .filter({ has: workspaceRow(page, workspaceId) });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });

  const rowsTestId = await rows.getAttribute("data-testid");
  const bucket = rowsTestId?.replace("sidebar-status-group-rows-", "");
  expect(bucket).toBeTruthy();

  await page.getByTestId(`sidebar-status-group-${bucket}`).click();
  await expect(workspaceRow(page, workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

function readSessionMessage(
  message: string | Buffer,
): { type?: unknown; requestId?: unknown } | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    if (envelope.type !== "session" || typeof envelope.message !== "object") {
      return null;
    }
    return envelope.message as { type?: unknown; requestId?: unknown };
  } catch {
    return null;
  }
}

const PIN_REJECTION_MESSAGE = "Pin rejected by test.";

interface PinRpcGate {
  /** Pin requests the client has sent so far. */
  sentCount(): number;
}

// Proxies everything so the app boots against the real daemon, counting pin RPCs and optionally
// rejecting the first `rejectFirst` of them. The count asserts how many pins one keypress actually
// dispatched, which the rendered pin state cannot show — a toggle that fired twice lands back
// where it started.
async function installPinRpcGate(
  page: Page,
  options: { rejectFirst?: number } = {},
): Promise<PinRpcGate> {
  const rejectFirst = options.rejectFirst ?? 0;
  let sent = 0;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = readSessionMessage(message);
      if (
        sessionMessage?.type === "workspace.pin.set.request" &&
        typeof sessionMessage.requestId === "string"
      ) {
        sent += 1;
        if (sent <= rejectFirst) {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId: sessionMessage.requestId,
                  requestType: "workspace.pin.set.request",
                  error: PIN_REJECTION_MESSAGE,
                  code: "transport",
                },
              },
            }),
          );
          return;
        }
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

  return { sentCount: () => sent };
}

test.describe("Pin workspace shortcut", () => {
  test("pins the active workspace while its project section is collapsed", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "pin-shortcut-collapsed-" });

    try {
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);
      await collapseProjectSection(page, workspace);

      await page.keyboard.press(PIN_SHORTCUT);

      await expect(pinnedSection(page)).toBeVisible({ timeout: 10_000 });
      await expect(
        pinnedSection(page).getByTestId(
          `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
        ),
      ).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });

  test("unpins the active workspace while the Pinned section is collapsed", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "pin-shortcut-unpin-" });

    try {
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      await page.keyboard.press(PIN_SHORTCUT);
      await expect(pinnedSection(page)).toBeVisible({ timeout: 10_000 });

      await page.getByTestId("sidebar-pinned-section-header").click();
      await expect(workspaceRow(page, workspace.workspaceId)).toHaveCount(0, { timeout: 10_000 });

      await page.keyboard.press(PIN_SHORTCUT);

      await expect(pinnedSection(page)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test("sends exactly one pin RPC per press when the row is rendered and selected", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "pin-shortcut-expanded-" });

    try {
      const gate = await installPinRpcGate(page);

      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      await page.keyboard.press(PIN_SHORTCUT);
      await expect(pinnedSection(page)).toBeVisible({ timeout: 10_000 });
      // Counting frames catches a press that produces zero or two RPCs — a misfiring in-flight
      // guard, or a second dispatch path. It cannot detect a duplicate handler registration:
      // `keyboardActionDispatcher.dispatch` returns at the first handler that returns true, so a
      // shadowed second handler is unobservable from outside by design.
      expect(gate.sentCount()).toBe(1);

      await page.keyboard.press(PIN_SHORTCUT);
      await expect(pinnedSection(page)).toHaveCount(0, { timeout: 10_000 });
      expect(gate.sentCount()).toBe(2);
      await expect(workspaceRow(page, workspace.workspaceId)).toHaveCount(1);
    } finally {
      await workspace.cleanup();
    }
  });

  test("pins the active workspace while its status group is collapsed", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "pin-shortcut-status-" });

    try {
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);
      await switchToStatusGrouping(page);
      await collapseStatusGroupContaining(page, workspace.workspaceId);

      await page.keyboard.press(PIN_SHORTCUT);

      await expect(pinnedSection(page)).toBeVisible({ timeout: 10_000 });
      await expect(
        pinnedSection(page).getByTestId(
          `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
        ),
      ).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });

  test("shows an error toast when the host rejects the pin, and the next press succeeds", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "pin-shortcut-failure-" });

    try {
      const gate = await installPinRpcGate(page, { rejectFirst: 1 });

      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      await page.keyboard.press(PIN_SHORTCUT);

      await expect(page.getByTestId("app-toast-message")).toContainText(PIN_REJECTION_MESSAGE, {
        timeout: 10_000,
      });
      await expect(pinnedSection(page)).toHaveCount(0);
      await expect(workspaceRow(page, workspace.workspaceId)).toHaveCount(1);

      // The failure must leave the action usable: the in-flight guard has to release the key so a
      // retry is not swallowed. Without that release the workspace is unpinnable for the session.
      await page.keyboard.press(PIN_SHORTCUT);

      await expect(pinnedSection(page)).toBeVisible({ timeout: 10_000 });
      expect(gate.sentCount()).toBe(2);
    } finally {
      await workspace.cleanup();
    }
  });
});
