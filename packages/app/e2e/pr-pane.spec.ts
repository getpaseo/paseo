import { test } from "./fixtures";
import {
  openPrPane,
  expectPrPaneTitle,
  expectPrPaneState,
  expectPrPaneCheckSummary,
  expectPrPaneActivityCount,
  seedPrFixture,
  seedTimelineFixture,
} from "./helpers/pr-pane";
import { gotoWorkspace } from "./helpers/launcher";
import { createTempGitRepo } from "./helpers/workspace";
import {
  connectWorkspaceSetupClient,
  type WorkspaceSetupDaemonClient,
} from "./helpers/workspace-setup";

function buildPrFixture(overrides: {
  title: string;
  state: string;
  isDraft?: boolean;
  mergedAt?: string | null;
  statusCheckRollup?: unknown[];
}) {
  return {
    number: 515,
    url: "https://github.com/getpaseo/paseo/pull/515",
    title: overrides.title,
    state: overrides.state,
    isDraft: overrides.isDraft ?? false,
    baseRefName: "main",
    headRefName: "",
    mergedAt: overrides.mergedAt ?? null,
    statusCheckRollup: overrides.statusCheckRollup ?? [],
    reviewDecision: null,
    headRepositoryOwner: { login: "getpaseo" },
  };
}

function buildCheckRun(
  name: string,
  conclusion: "SUCCESS" | "FAILURE" | null,
  status = conclusion === null ? "IN_PROGRESS" : "COMPLETED",
) {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    detailsUrl: `https://github.com/getpaseo/paseo/actions/runs/1/jobs/${name}`,
    workflowName: "CI",
  };
}

const TIMELINE_WITH_3_ACTIVITIES = {
  data: {
    repository: {
      pullRequest: {
        number: 515,
        reviews: {
          nodes: [
            {
              id: "rev1",
              state: "APPROVED",
              body: "LGTM",
              url: "https://github.com/getpaseo/paseo/pull/515#pullrequestreview-1",
              submittedAt: "2024-01-01T10:00:00Z",
              author: { login: "alice", url: "https://github.com/alice" },
            },
            {
              id: "rev2",
              state: "CHANGES_REQUESTED",
              body: "Please fix the tests",
              url: "https://github.com/getpaseo/paseo/pull/515#pullrequestreview-2",
              submittedAt: "2024-01-01T11:00:00Z",
              author: { login: "bob", url: "https://github.com/bob" },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        comments: {
          nodes: [
            {
              id: "cmt1",
              body: "Nice work!",
              url: "https://github.com/getpaseo/paseo/pull/515#issuecomment-1",
              createdAt: "2024-01-01T09:00:00Z",
              author: { login: "charlie", url: "https://github.com/charlie" },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  },
};

interface WorkspaceState {
  workspaceId: string;
  cleanup: () => Promise<void>;
}

async function setupPrWorkspace(
  client: WorkspaceSetupDaemonClient,
  prefix: string,
  prFixture: object,
  timelineFixture?: object,
): Promise<WorkspaceState> {
  const repo = await createTempGitRepo(prefix, {
    originUrl: "https://github.com/getpaseo/paseo.git",
  });
  await seedPrFixture(repo.path, prFixture);
  if (timelineFixture) {
    await seedTimelineFixture(repo.path, timelineFixture);
  }
  const result = await client.openProject(repo.path);
  if (!result.workspace) {
    await repo.cleanup();
    throw new Error(result.error ?? `Failed to open project ${repo.path}`);
  }
  return {
    workspaceId: result.workspace.id,
    cleanup: repo.cleanup,
  };
}

test.describe("PR pane", () => {
  test.describe.configure({ retries: 1 });

  let seedClient: WorkspaceSetupDaemonClient;
  let openPrWs: WorkspaceState;
  let mergedPrWs: WorkspaceState;
  let closedPrWs: WorkspaceState;
  let draftPrWs: WorkspaceState;
  let checkPillsWs: WorkspaceState;
  let activityWs: WorkspaceState;
  let emptyChecksWs: WorkspaceState;

  test.beforeAll(async () => {
    seedClient = await connectWorkspaceSetupClient();

    [openPrWs, mergedPrWs, closedPrWs, draftPrWs, checkPillsWs, activityWs, emptyChecksWs] =
      await Promise.all([
        setupPrWorkspace(
          seedClient,
          "pr-pane-open-",
          buildPrFixture({ title: "Review selected start ref", state: "OPEN" }),
        ),
        setupPrWorkspace(
          seedClient,
          "pr-pane-merged-",
          buildPrFixture({
            title: "Merged feature branch",
            state: "MERGED",
            mergedAt: "2024-01-01T12:00:00Z",
          }),
        ),
        setupPrWorkspace(
          seedClient,
          "pr-pane-closed-",
          buildPrFixture({ title: "Closed without merge", state: "CLOSED" }),
        ),
        setupPrWorkspace(
          seedClient,
          "pr-pane-draft-",
          buildPrFixture({ title: "Work in progress", state: "OPEN", isDraft: true }),
        ),
        setupPrWorkspace(
          seedClient,
          "pr-pane-checks-",
          buildPrFixture({
            title: "PR with mixed checks",
            state: "OPEN",
            statusCheckRollup: [
              buildCheckRun("build-1", "SUCCESS"),
              buildCheckRun("build-2", "SUCCESS"),
              buildCheckRun("deploy", "FAILURE"),
              buildCheckRun("security", null),
            ],
          }),
        ),
        setupPrWorkspace(
          seedClient,
          "pr-pane-activity-",
          buildPrFixture({ title: "PR with reviews", state: "OPEN" }),
          TIMELINE_WITH_3_ACTIVITIES,
        ),
        setupPrWorkspace(
          seedClient,
          "pr-pane-empty-",
          buildPrFixture({ title: "PR with no checks", state: "OPEN", statusCheckRollup: [] }),
        ),
      ]);
  });

  test.afterAll(async () => {
    await Promise.all([
      openPrWs?.cleanup(),
      mergedPrWs?.cleanup(),
      closedPrWs?.cleanup(),
      draftPrWs?.cleanup(),
      checkPillsWs?.cleanup(),
      activityWs?.cleanup(),
      emptyChecksWs?.cleanup(),
    ]);
    await seedClient?.close().catch(() => undefined);
  });

  test("renders an open PR with title, state, and repo line", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, openPrWs.workspaceId);
    await openPrPane(page);

    await expectPrPaneTitle(page, "Review selected start ref");
    await expectPrPaneState(page, "open");
  });

  test("renders merged state label and icon", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, mergedPrWs.workspaceId);
    await openPrPane(page);

    await expectPrPaneState(page, "merged");
    await expectPrPaneTitle(page, "Merged feature branch");
  });

  test("renders closed state label and icon", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, closedPrWs.workspaceId);
    await openPrPane(page);

    await expectPrPaneState(page, "closed");
    await expectPrPaneTitle(page, "Closed without merge");
  });

  test("renders draft state label and icon", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, draftPrWs.workspaceId);
    await openPrPane(page);

    await expectPrPaneState(page, "draft");
    await expectPrPaneTitle(page, "Work in progress");
  });

  test("renders check pills with correct passed/failed/pending counts", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, checkPillsWs.workspaceId);
    await openPrPane(page);

    await expectPrPaneCheckSummary(page, { passed: 2, failed: 1, pending: 1 });
  });

  test("renders activity rows with correct count", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, activityWs.workspaceId);
    await openPrPane(page);

    await expectPrPaneActivityCount(page, 3);
  });

  test("renders gracefully with zero checks", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, emptyChecksWs.workspaceId);
    await openPrPane(page);

    await expectPrPaneCheckSummary(page, { passed: 0, failed: 0, pending: 0 });
    await expectPrPaneTitle(page, "PR with no checks");
  });
});
