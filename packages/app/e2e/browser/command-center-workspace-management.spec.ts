import type { Locator } from "@playwright/test";
import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// These actions used to be reachable only from the sidebar workspace ⋯ menu, the workspace header
// menu, or an unlisted keybind. Rename was the worst of them: its dialog lived inside the sidebar
// row, so it vanished whenever that row was unmounted — a collapsed section, or focus mode.

function workspaceRow(page: Page, workspaceId: string): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function action(panel: Locator, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return panel.getByRole("button", { name: new RegExp(`^${escaped}(?:\\s|$)`) });
}

async function openWorkspace(page: Page, workspaceId: string): Promise<void> {
  const row = workspaceRow(page, workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
}

// Collapsing the project section unmounts every workspace row under it, which is exactly the state
// that used to make the sidebar-owned rename dialog unreachable.
async function collapseProjectSection(page: Page, project: SeededWorkspace): Promise<void> {
  const header = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: project.projectDisplayName });
  await expect(header).toHaveCount(1, { timeout: 30_000 });
  await header.click();
  await expect(workspaceRow(page, project.workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

// The shared helper clicks the sidebar's search button, which is inside the Workspaces section
// header — absent on /settings and once every workspace has moved to Pinned. Cmd-K is the
// surface under test anyway, and it works from every route.
async function openCommandCenter(page: Page): Promise<Locator> {
  await page.keyboard.press("ControlOrMeta+K");
  const panel = page.getByTestId("command-center-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

async function runCommand(page: Page, query: string, title: string): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(query);
  const entry = action(panel, title);
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await entry.click();
}

async function readWorkspaceLabels(workspace: SeededWorkspace): Promise<string[] | undefined> {
  const workspaces = await workspace.client.fetchWorkspaces();
  for (const entry of workspaces.entries) {
    if (entry.id === workspace.workspaceId) return entry.labels?.slice().sort();
  }
  return undefined;
}

async function rejectNextLabelAssignment(page: Page): Promise<void> {
  let rejectNext = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      let request: { type?: string; requestId?: string } | null = null;
      try {
        const envelope = JSON.parse(raw) as {
          type?: string;
          message?: { type?: string; requestId?: string };
        };
        request = envelope.type === "session" ? (envelope.message ?? null) : null;
      } catch {
        server.send(message);
        return;
      }
      if (
        rejectNext &&
        request?.type === "workspace.label.assignment.set.request" &&
        request.requestId
      ) {
        rejectNext = false;
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                error: "Injected label mutation failure.",
                code: "handler_error",
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
}

test.describe("Command center workspace management", () => {
  test("renames the active workspace while its sidebar row is unmounted", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "cc-rename-" });

    try {
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);
      await collapseProjectSection(page, workspace);

      await runCommand(page, "rename", "Rename workspace");

      // Focused, not merely visible. A modal that mounts behind the closing palette, or loses the
      // focus race with its focus-restore, still renders — you just cannot type into it.
      const input = page.getByTestId("workspace-rename-modal-global-input");
      await expect(input).toBeFocused({ timeout: 15_000 });
      await expect(input).toHaveValue(workspace.workspaceName);

      const customTitle = "Renamed From Palette";
      await input.fill(customTitle);
      await page.getByTestId("workspace-rename-modal-global-submit").click();
      await expect(input).toHaveCount(0, { timeout: 15_000 });

      // Re-expand the section to read the row back.
      const header = page
        .locator('[data-testid^="sidebar-project-row-"]')
        .filter({ hasText: workspace.projectDisplayName });
      await header.click();
      await expect(workspaceRow(page, workspace.workspaceId)).toContainText(customTitle, {
        timeout: 15_000,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("copies the workspace path and confirms with a toast", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "cc-copy-path-" });

    try {
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      await runCommand(page, "copy path", "Copy workspace path");

      // toast.copied wraps its label: "Copied {{label}}" with label "Path copied".
      await expect(page.getByText("Copied Path copied", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("flips the pin entry to Unpin after pinning from the palette", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "cc-pin-" });

    try {
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      await runCommand(page, "pin", "Pin to top");
      await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible({ timeout: 15_000 });

      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("pin");
      await expect(action(panel, "Unpin")).toBeVisible({ timeout: 15_000 });
      await expect(action(panel, "Pin to top")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  // Regression guard for the registration split. Toggle Explorer sidebar and Toggle focus mode are
  // handled only by workspace-screen.tsx behind `enabled: isRouteFocused && ...`, so listing them
  // off a workspace route would give the user two entries that close the palette and do nothing.
  // Toggle left sidebar calls the panel store directly and works everywhere, so it stays listed.
  test("lists only the globally-handled toggle off a workspace route", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "cc-toggle-scope-" });

    try {
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      // All three are listed while a workspace route owns the handlers.
      const workspacePanel = await openCommandCenter(page);
      await workspacePanel.getByTestId("command-center-input").fill("toggle");
      await expect(action(workspacePanel, "Toggle left sidebar")).toBeVisible({ timeout: 15_000 });
      await expect(action(workspacePanel, "Toggle Explorer sidebar")).toBeVisible();
      await expect(action(workspacePanel, "Toggle focus mode")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("command-center-panel")).toHaveCount(0);

      await page.locator('[data-testid="sidebar-settings"]:visible').first().click();
      await expect(page.getByTestId("settings-sidebar")).toBeVisible({ timeout: 30_000 });

      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("toggle");

      await expect(action(panel, "Toggle left sidebar")).toBeVisible({ timeout: 15_000 });
      await expect(action(panel, "Toggle Explorer sidebar")).toHaveCount(0);
      await expect(action(panel, "Toggle focus mode")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("toggles a label on the active workspace from the palette", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "cc-label-" });

    try {
      await workspace.client.setWorkspaceLabel({
        workspaceId: workspace.workspaceId,
        label: { name: "Urgent", color: "red" },
        assigned: true,
      });

      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("urgent");
      await panel.getByTestId("command-center-workspace-label-Urgent").click();
      // Unassigning the only label drops the field entirely rather than leaving an empty array.
      await expect.poll(() => readWorkspaceLabels(workspace)).toEqual(undefined);

      const reopened = await openCommandCenter(page);
      await reopened.getByTestId("command-center-input").fill("urgent");
      await reopened.getByTestId("command-center-workspace-label-Urgent").click();
      await expect.poll(() => readWorkspaceLabels(workspace)).toEqual(["Urgent"]);
    } finally {
      await workspace.cleanup();
    }
  });

  test("shows an error toast when assigning a label fails", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "cc-label-failure-" });

    try {
      await rejectNextLabelAssignment(page);
      await workspace.client.setWorkspaceLabel({
        workspaceId: workspace.workspaceId,
        label: { name: "Urgent", color: "red" },
        assigned: true,
      });

      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("urgent");
      await panel.getByTestId("command-center-workspace-label-Urgent").click();

      await expect(page.getByTestId("app-toast-message")).toContainText(
        "Injected label mutation failure.",
      );
      await expect.poll(() => readWorkspaceLabels(workspace)).toEqual(["Urgent"]);
    } finally {
      await workspace.cleanup();
    }
  });
});
