import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  connectWorkspaceSetupClient,
  openHomeWithProject,
  openWorkspaceScriptsMenu,
  seedProjectForWorkspaceSetup,
  startWorkspaceScriptFromMenu,
} from "../support/helpers/workspace-setup";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

const evidenceDir = "/tmp/fork-setup-gate";

test("fork workspace setup stays blocked until the user runs it", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(evidenceDir, { recursive: true });
  const client = await connectWorkspaceSetupClient();
  const repo = await createTempGitRepo("fork-setup-gate-", {
    withRemote: true,
    originUrl: "https://github.com/paseo-e2e/local-fixture.git",
    branches: ["pr-branch-2"],
    paseoConfig: {
      worktree: {
        setup: ["node -e \"setTimeout(() => console.log('setup complete'), 1500)\""],
      },
      scripts: { dev: { command: 'node -e "setTimeout(() => {}, 30000)"' } },
    },
  });

  try {
    const localRemote = path.join(repo.path, "remote.git");
    execFileSync("git", ["update-ref", "refs/pull/2/head", "refs/heads/pr-branch-2"], {
      cwd: localRemote,
    });
    execFileSync(
      "git",
      ["config", `url.${localRemote}.insteadOf`, "git@github.com:fork-owner/local-fixture.git"],
      { cwd: repo.path },
    );
    execFileSync(
      "git",
      [
        "config",
        "--add",
        `url.${localRemote}.insteadOf`,
        "https://github.com/paseo-e2e/local-fixture.git",
      ],
      { cwd: repo.path },
    );
    await seedProjectForWorkspaceSetup(client, repo.path);
    const result = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repo.path,
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: "github", number: 2 },
      },
    });
    if (!result.workspace || result.error)
      throw new Error(result.error ?? "Workspace creation failed");
    expect(result.setupSkippedReason).toContain("Scripts are blocked for PR #2");

    await openHomeWithProject(page, repo.path);
    await page.goto(buildHostWorkspaceRoute(getServerId(), result.workspace.id));
    await waitForWorkspaceTabsVisible(page);

    await test.step("the blocked setup tab opens with the fork warning", async () => {
      await expect(page.getByTestId("workspace-setup-panel")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("alert")).toContainText("fork-owner/local-fixture");
      await expect(page.getByRole("button", { name: "Run setup" })).toBeVisible();
      await page.screenshot({
        path: path.join(evidenceDir, "blocked-fork-setup.png"),
        fullPage: true,
      });
    });

    await test.step("starting a script explains why it is blocked", async () => {
      await openWorkspaceScriptsMenu(page);
      await startWorkspaceScriptFromMenu(page, "dev");
      await expect(page.getByText(/Scripts are blocked for PR #2/)).toBeVisible();
      await page.screenshot({
        path: path.join(evidenceDir, "blocked-script-error.png"),
        fullPage: true,
      });
      await page.reload();
      await waitForWorkspaceTabsVisible(page);
      await expect(page.getByRole("button", { name: "Run setup" })).toBeVisible();
    });

    await test.step("running setup replaces the warning with normal progress", async () => {
      await page.getByRole("button", { name: "Run setup" }).click();
      await expect(page.getByTestId("workspace-setup-status")).toContainText(/Running|Completed/, {
        timeout: 30_000,
      });
      await page.screenshot({
        path: path.join(evidenceDir, "fork-setup-running.png"),
        fullPage: true,
      });
      await expect(page.getByTestId("workspace-setup-status")).toContainText("Completed", {
        timeout: 30_000,
      });
    });
  } finally {
    await client.close();
    await repo.cleanup();
  }
});
