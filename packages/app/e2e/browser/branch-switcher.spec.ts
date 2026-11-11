import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectNoBranchSwitcherInWorkspaceHeader,
  expectWorkspaceBranch,
  openChangesPanel,
  switchBranchFromChangesPanel,
} from "../support/helpers/branch-switcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { readWorktreeBranchInfo } from "../support/helpers/workspace";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

// Hold the real daemon response until the test has observed the pending UI.
async function holdBranchSuggestions(page: Page) {
  let requestCount = 0;
  let release!: () => void;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message);
        if (envelope.type === "session" && envelope.message?.type === "branch_suggestions_request")
          requestCount++;
      }
      server.send(message);
    });
    server.onMessage(async (message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message);
        if (
          envelope.type === "session" &&
          envelope.message?.type === "branch_suggestions_response"
        ) {
          await gate;
        }
      }
      browser.send(message);
    });
  });
  return {
    release: () => release(),
    holdNextResponse: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    requestCount: () => requestCount,
  };
}

async function expectInitialBranchLoading(page: Page, release: () => void): Promise<void> {
  await page.getByRole("button", { name: "Current branch: main. Press to switch branch." }).click();
  const picker = page.getByTestId("combobox-desktop-container");
  await expect(picker.getByText("Loading...", { exact: true })).toBeVisible();
  await expect(picker.getByText("No branches found.", { exact: true })).toHaveCount(0);
  release();
  await expect(picker.getByText("dev", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
}

async function expectFailedRefreshRecovery(
  page: Page,
  repoPath: string,
  responses: Awaited<ReturnType<typeof holdBranchSuggestions>>,
) {
  // Expire the actual query freshness window before reopening the cached picker.
  const started = Date.now();
  await expect.poll(() => Date.now() - started, { timeout: 20_000 }).toBeGreaterThan(15_000);
  const picker = page.getByTestId("combobox-desktop-container");
  const packedRefs = path.join(repoPath, ".git", "packed-refs");
  await writeFile(packedRefs, "invalid packed refs\n");
  try {
    await page
      .getByRole("button", { name: "Current branch: dev. Press to switch branch." })
      .click();
    await expect(picker.getByRole("alert")).toHaveText(
      "Could not load branches. Reopen the picker to try again.",
    );
  } finally {
    await unlink(packedRefs);
  }
  await expect(picker.getByText("No branches found.", { exact: true })).toHaveCount(0);
  responses.holdNextResponse();
  const beforeRetry = responses.requestCount();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Current branch: dev. Press to switch branch." }).click();
  await expect(picker.getByRole("alert")).toHaveText("Loading...");
  await expect.poll(responses.requestCount).toBe(beforeRetry + 1);
  await expect(picker).toBeVisible();
  responses.release();
  await expect(picker.getByRole("alert")).toHaveCount(0);
  await expect(picker.getByText("main", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectWorkspaceBranch(page, "dev");
  expect(responses.requestCount()).toBe(beforeRetry + 1);
}

async function renameWorkspaceViaSidebar(
  page: Page,
  input: { workspaceId: string; title: string },
): Promise<void> {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${input.workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${input.workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const renameItem = page.getByTestId(
    `sidebar-workspace-menu-rename-${serverId}:${input.workspaceId}`,
  );
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();

  // Desktop-width sidebars rename in place.
  const renameInput = page.getByTestId(
    `sidebar-workspace-rename-input-${serverId}:${input.workspaceId}`,
  );
  await expect(renameInput).toBeFocused({ timeout: 10_000 });
  await renameInput.fill(input.title);
  await renameInput.press("Enter");
  await expect(renameInput).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Branch switcher", () => {
  // The first test after a spec-file switch can fail while the shared daemon
  // releases stale sessions from the previous spec; one retry stabilizes it.
  test.describe.configure({ retries: 1 });

  test("a custom workspace title stays in the header while the diff panel switches the real branch", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();
    const workspace = await seedWorkspace({
      repoPrefix: "branch-coherence-",
      repo: { branches: ["main", "dev"] },
    });

    try {
      expect(workspace.workspaceName).toBe("main");

      const releaseBranches = await holdBranchSuggestions(page);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });

      const customTitle = "Payments Refactor";
      await renameWorkspaceViaSidebar(page, {
        workspaceId: workspace.workspaceId,
        title: customTitle,
      });

      // The header shows the custom title verbatim (a plain static title), never a
      // branch name, and the branch switcher does not live in the header.
      const headerTitle = page
        .getByTestId("workspace-header-title")
        .filter({ visible: true })
        .first();
      await expect(headerTitle).toHaveText(customTitle, { timeout: 30_000 });
      await expectNoBranchSwitcherInWorkspaceHeader(page);

      // The diff panel's switcher tracks the real branch ("main"), not the title,
      // and switching it checks out the real branch on disk.
      await openChangesPanel(page);
      await expectWorkspaceBranch(page, "main");
      await expectInitialBranchLoading(page, releaseBranches.release);
      await switchBranchFromChangesPanel(page, { from: "main", to: "dev" });
      await expectWorkspaceBranch(page, "dev");
      await expectFailedRefreshRecovery(page, workspace.repoPath, releaseBranches);

      // The custom title is unaffected by the branch switch.
      await expect(headerTitle).toHaveText(customTitle, { timeout: 30_000 });

      await expect
        .poll(
          async () =>
            (await readWorktreeBranchInfo({ worktreePath: workspace.repoPath })).currentBranch,
          { timeout: 30_000 },
        )
        .toBe("dev");
    } finally {
      await workspace.cleanup();
    }
  });
});
