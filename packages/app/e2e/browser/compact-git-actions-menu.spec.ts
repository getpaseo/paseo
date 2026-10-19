import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo, resolveTempRoot } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

// The compact toolbar flattens every git action into one menu, and the policy keeps the actions
// it can promote to `primary` in `secondary` as well. A promoted action must still show once.
const cleanupTasks: Array<() => Promise<void>> = [];

test.afterEach(async () => {
  for (const task of cleanupTasks.splice(0)) {
    await task();
  }
});

async function createRemoteRepo(prefix: string): Promise<string> {
  const repo = await createTempGitRepo(prefix, {
    withRemote: true,
    files: [{ path: "src/app.ts", content: "export const app = 1;\n" }],
  });
  cleanupTasks.push(repo.cleanup);
  // The helper puts the bare remote inside the checkout; keep it out of the status.
  await writeFile(path.join(repo.path, ".git/info/exclude"), "remote.git/\n");
  return repo.path;
}

async function registerWorkspace(repoPath: string): Promise<string> {
  const client = await connectSeedClient();
  cleanupTasks.push(async () => {
    await client.close().catch(() => undefined);
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repoPath } });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create workspace ${repoPath}`);
  }
  return created.workspace.id;
}

async function openCompactActionsMenu(page: Page, workspaceId: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
  await page.reload();
  await page.getByTestId("workspace-explorer-toggle").first().click();
  const changesTab = page.getByTestId("explorer-tab-changes").filter({ visible: true });
  await expect(changesTab).toBeVisible({ timeout: 30_000 });
  await changesTab.click();
  const explorer = page.getByTestId("explorer-content-area").filter({ visible: true });
  await expect(explorer.getByTestId("changes-header")).toBeVisible({ timeout: 30_000 });

  const trigger = explorer.getByTestId("changes-actions-menu-trigger");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  const menu = page.getByTestId("changes-primary-cta-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("compact git actions menu lists a promoted Pull once", async ({ page }) => {
  const repoPath = await createRemoteRepo("compact-menu-pull-");
  cleanupTasks.push(async () => {
    execFileSync("rm", ["-rf", repoPath]);
  });

  // Advance origin so the clean checkout is behind it and Pull is the promoted action.
  const other = await mkdtemp(path.join(await resolveTempRoot(), "compact-menu-other-"));
  cleanupTasks.push(async () => {
    execFileSync("rm", ["-rf", other]);
  });
  execFileSync("git", ["clone", path.join(repoPath, "remote.git"), other], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "e2e@paseo.test"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Paseo E2E"], { cwd: other, stdio: "ignore" });
  await writeFile(path.join(other, "src/incoming.ts"), "export const incoming = 1;\n");
  execFileSync("git", ["add", "--all"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Incoming commit"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: other, stdio: "ignore" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoPath, stdio: "ignore" });

  const workspaceId = await registerWorkspace(repoPath);
  const menu = await openCompactActionsMenu(page, workspaceId);

  await expect(menu.getByTestId("changes-menu-pull")).toHaveCount(1);
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Pull",
    "Push",
    "Pull and push",
    "Archive workspace",
  ]);
});

test("compact git actions menu lists a promoted Push once", async ({ page }) => {
  const repoPath = await createRemoteRepo("compact-menu-push-");
  cleanupTasks.push(async () => {
    execFileSync("rm", ["-rf", repoPath]);
  });
  const workspaceId = await registerWorkspace(repoPath);

  // Commit so the clean checkout is ahead of origin and Push is the promoted action.
  await writeFile(path.join(repoPath, "src/mine.ts"), "export const mine = 1;\n");
  execFileSync("git", ["add", "--all"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Local commit"], { cwd: repoPath, stdio: "ignore" });

  const menu = await openCompactActionsMenu(page, workspaceId);

  await expect(menu.getByTestId("changes-menu-push")).toHaveCount(1);
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Push",
    "Pull",
    "Pull and push",
    "Archive workspace",
  ]);
});
