import { test } from "../support/fixtures";
import {
  openPrPane,
  expectPrPaneTitle,
  expectPrPaneState,
  expectPrPaneChecks,
  expectPrPaneActivity,
} from "../support/helpers/pr-pane";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  hasGithubAuth,
  createTempGithubRepo,
  type GhRepoFixture,
} from "../support/helpers/github-fixtures";
import {
  connectWorkspaceSetupClient,
  openProjectViaDaemon,
  type WorkspaceSetupDaemonClient,
} from "../support/helpers/workspace-setup";

const GITHUB_AUTH = hasGithubAuth();

test.describe("PR pane", () => {
  test.describe.configure({ retries: 1 });

  let seedClient: WorkspaceSetupDaemonClient;
  let repoFixture: GhRepoFixture;
  const workspaceByTitle = new Map<string, string>();

  test.beforeAll(async () => {
    if (!GITHUB_AUTH) return;

    seedClient = await connectWorkspaceSetupClient();

    repoFixture = await createTempGithubRepo({
      category: "pr-pane",
      prs: [
        { title: "Review selected start ref", state: "open" },
        { title: "Merged feature branch", state: "merged" },
        { title: "Closed without merge", state: "closed" },
        { title: "Work in progress", state: "draft" },
        {
          title: "PR with mixed checks",
          state: "open",
          checks: [
            { context: "build-1", state: "success" },
            { context: "build-2", state: "success" },
            { context: "deploy", state: "failure" },
            { context: "security", state: "pending" },
          ],
        },
        { title: "PR with reviews", state: "open", commentCount: 3 },
      ],
    });

    for (const pr of repoFixture.prs) {
      const workspace = await openProjectViaDaemon(seedClient, pr.localPath);
      workspaceByTitle.set(pr.title, workspace.id);
    }
  });

  test.afterAll(async () => {
    await repoFixture?.cleanup().catch(() => undefined);
    await seedClient?.close().catch(() => undefined);
  });

  test.beforeEach(async () => {
    test.skip(!GITHUB_AUTH, "Requires GitHub authentication (gh auth login)");
    test.setTimeout(60_000);
  });

  test("renders an open PR with title, state, and repo line", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Review selected start ref")!);
    await openPrPane(page);

    await expectPrPaneTitle(page, "Review selected start ref");
    await expectPrPaneState(page, "open");
  });

  test("renders merged state label and icon", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Merged feature branch")!);
    await openPrPane(page);

    await expectPrPaneState(page, "merged");
    await expectPrPaneTitle(page, "Merged feature branch");
  });

  test("renders closed state label and icon", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Closed without merge")!);
    await openPrPane(page);

    await expectPrPaneState(page, "closed");
    await expectPrPaneTitle(page, "Closed without merge");
  });

  test("renders draft state label and icon", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("Work in progress")!);
    await openPrPane(page);

    await expectPrPaneState(page, "draft");
    await expectPrPaneTitle(page, "Work in progress");
  });

  test("renders seeded checks in their success, failure, and pending groups", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("PR with mixed checks")!);
    await openPrPane(page);

    await expectPrPaneChecks(page, {
      success: ["build-1", "build-2"],
      failure: ["deploy"],
      pending: ["security"],
    });
  });

  test("renders every seeded activity comment", async ({ page }) => {
    await gotoWorkspace(page, workspaceByTitle.get("PR with reviews")!);
    await openPrPane(page);

    await expectPrPaneActivity(page, ["Test comment 1", "Test comment 2", "Test comment 3"]);
  });
});
