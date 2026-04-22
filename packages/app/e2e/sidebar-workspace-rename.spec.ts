import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { createTempGitRepo } from "./helpers/workspace";
import { connectWorkspaceSetupClient } from "./helpers/workspace-setup";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function workspaceKebabTestId(workspaceId: string): string {
  return `sidebar-workspace-kebab-${getServerId()}:${workspaceId}`;
}

function workspaceRenameMenuItemTestId(workspaceId: string): string {
  return `sidebar-workspace-menu-rename-${getServerId()}:${workspaceId}`;
}

function workspaceRenameModalTestId(workspaceId: string, suffix: string): string {
  return `sidebar-workspace-rename-modal-${getServerId()}:${workspaceId}-${suffix}`;
}

async function openProjectViaDaemon(
  client: Awaited<ReturnType<typeof connectWorkspaceSetupClient>>,
  cwd: string,
): Promise<{ id: string; name: string; workspaceDirectory: string }> {
  const result = await client.openProject(cwd);
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? `Failed to open project ${cwd}`);
  }
  return {
    id: String(result.workspace.id),
    name: result.workspace.name,
    workspaceDirectory: result.workspace.workspaceDirectory,
  };
}

async function openWorkspaceKebab(page: Page, workspaceId: string) {
  const row = page.getByTestId(workspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(workspaceKebabTestId(workspaceId));
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();
}

async function openRenameModal(page: Page, workspaceId: string) {
  await openWorkspaceKebab(page, workspaceId);

  const renameItem = page.getByTestId(workspaceRenameMenuItemTestId(workspaceId));
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();

  const input = page.getByTestId(workspaceRenameModalTestId(workspaceId, "input"));
  await expect(input).toBeVisible({ timeout: 10_000 });
  return input;
}

test.describe("Sidebar workspace rename", () => {
  test("renaming via kebab updates the branch name on disk and in the sidebar", async ({
    page,
  }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("sidebar-rename-");

    try {
      const workspace = await openProjectViaDaemon(client, repo.path);
      expect(workspace.name).toBe("main");

      const renameRequests: Array<{ branch: string; cwd: string }> = [];
      page.on("websocket", (ws) => {
        ws.on("framesent", (frame) => {
          const raw = frame.payload;
          const text = typeof raw === "string" ? raw : raw.toString("utf8");
          try {
            const outer = JSON.parse(text) as {
              type?: string;
              message?: { type?: string; cwd?: unknown; branch?: unknown };
            };
            const inner = outer.message;
            if (outer.type === "session" && inner?.type === "checkout_rename_branch_request") {
              renameRequests.push({
                branch: String(inner.branch ?? ""),
                cwd: String(inner.cwd ?? ""),
              });
            }
          } catch {
            // Ignore non-JSON and binary frames.
          }
        });
      });

      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.id));
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText("main");

      const input = await openRenameModal(page, workspace.id);
      await expect(input).toHaveValue("main");

      await input.fill("Feature Rename 2");
      await expect(input).toHaveValue("feature-rename-2");

      await page.getByTestId(workspaceRenameModalTestId(workspace.id, "submit")).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId(workspaceRowTestId(workspace.id))).toContainText(
        "feature-rename-2",
        { timeout: 15_000 },
      );

      expect(renameRequests.length).toBeGreaterThan(0);
      expect(renameRequests.at(-1)).toEqual({
        branch: "feature-rename-2",
        cwd: workspace.workspaceDirectory,
      });

      const currentBranchOnDisk = execSync("git branch --show-current", {
        cwd: repo.path,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(currentBranchOnDisk).toBe("feature-rename-2");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("rename surfaces server errors inline and keeps the modal open", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("sidebar-rename-error-", { branches: ["taken"] });

    try {
      const workspace = await openProjectViaDaemon(client, repo.path);

      await gotoAppShell(page);
      const input = await openRenameModal(page, workspace.id);
      await expect(input).toHaveValue("main");

      await input.fill("taken");
      await expect(input).toHaveValue("taken");

      await page.getByTestId(workspaceRenameModalTestId(workspace.id, "submit")).click();

      const errorNode = page.getByTestId(workspaceRenameModalTestId(workspace.id, "error"));
      await expect(errorNode).toBeVisible({ timeout: 15_000 });
      await expect(errorNode).toContainText(/already exists|branch/i);

      await expect(input).toBeVisible();
      await expect(page.getByTestId(workspaceRowTestId(workspace.id))).toContainText("main");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
