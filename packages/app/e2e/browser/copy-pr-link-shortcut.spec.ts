import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  connectWorkspaceSetupClient,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
  type WorkspaceSetupDaemonClient,
} from "../support/helpers/workspace-setup";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

// The e2e worker's fake `gh` answers `pr view` for the paseo-e2e/local-fixture remote with a
// PR whose URL is fixed, so the whole PR-detection path runs locally without network access.
const PR_URL = "https://github.com/paseo-e2e/local-fixture/pull/1";
const PR_BRANCH = "pr-branch-1";
const evidenceDir = "/tmp/pr-copy-shortcut";

function pressCopyPrLinkShortcut(page: import("@playwright/test").Page) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  return page.keyboard.press(`${modifier}+Shift+C`);
}

/** A local repo whose origin looks like the fixture GitHub remote the fake `gh` answers for. */
/** Creates the workspace and turns the RPC error shape into a thrown test failure. */
async function createWorkspaceOrFail(
  client: WorkspaceSetupDaemonClient,
  source: Parameters<WorkspaceSetupDaemonClient["createWorkspace"]>[0]["source"],
) {
  const result = await client.createWorkspace({ source });
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? "Workspace creation failed");
  }
  return result.workspace;
}

async function createFixtureRepo(prefix: string, branch: string) {
  const repo = await createTempGitRepo(prefix, {
    withRemote: true,
    originUrl: "https://github.com/paseo-e2e/local-fixture.git",
    branches: [branch],
  });
  execFileSync("git", ["update-ref", `refs/pull/1/head`, `refs/heads/${branch}`], {
    cwd: path.join(repo.path, "remote.git"),
  });
  const localRemote = path.join(repo.path, "remote.git");
  execFileSync(
    "git",
    ["config", `url.${localRemote}.insteadOf`, "git@github.com:paseo-e2e/local-fixture.git"],
    {
      cwd: repo.path,
    },
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
  return repo;
}

test("copies the workspace change request link with Cmd/Ctrl+Shift+C", async ({
  page,
  context,
}) => {
  // Clipboard reads need the browser permissions granted before the press.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const client = await connectWorkspaceSetupClient();
  const repo = await createFixtureRepo("pr-copy-shortcut-", PR_BRANCH);
  try {
    await seedProjectForWorkspaceSetup(client, repo.path);
    const workspace = await createWorkspaceOrFail(client, {
      kind: "worktree",
      cwd: repo.path,
      action: "checkout",
      checkoutSource: { kind: "change_request", forge: "github", number: 1 },
    });

    await openHomeWithProject(page, repo.path);
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
    await waitForWorkspaceTabsVisible(page);

    // The shortcut reads the change request off the workspace descriptor, so wait until the
    // workspace header shows the View PR action before pressing it.
    await expect(page.getByRole("button", { name: "View PR" })).toBeVisible({
      timeout: 30_000,
    });

    await pressCopyPrLinkShortcut(page);

    // toast.copied wraps its label: "Copied {{label}}" with the forge-noun label "PR link".
    await expect(page.getByText("Copied PR link", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
      .toBe(PR_URL);
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, "copied-pr-link-toast.png") });
  } finally {
    await client.close();
    await repo.cleanup();
  }
});

test("shows an error toast when the workspace has no change request", async ({ page }) => {
  const client = await connectWorkspaceSetupClient();
  // A plain repo with no GitHub remote: no change request to copy.
  const repo = await createTempGitRepo("pr-copy-shortcut-none-");
  try {
    await seedProjectForWorkspaceSetup(client, repo.path);
    const workspace = await createWorkspaceOrFail(client, {
      kind: "directory",
      path: repo.path,
    });

    await openHomeWithProject(page, repo.path);
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
    await waitForWorkspaceTabsVisible(page);

    await pressCopyPrLinkShortcut(page);

    await expect(
      page.getByText("No change request found for this workspace", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await client.close();
    await repo.cleanup();
  }
});
