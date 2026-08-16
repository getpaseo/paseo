import { expect, test, vi } from "vitest";
import { fetchBoundPullRequestCheckDetails } from "./check-details";

test("selected PR check details keep their bound identity and return runtime logs", async () => {
  const getForgeCheckDetails = vi.fn(async () => ({
    cwd: "/shared",
    requestId: "check-details",
    success: true,
    details: {
      checkRunId: 42,
      name: "Runtime check",
      output: { title: "Runtime check", summary: "failed", text: "runtime log attachment" },
      annotations: [],
      failedJobs: [],
      truncated: false,
    },
    error: null,
  }));
  const workspaceGit = {
    workspaceId: "workspace-selected",
    cwd: "/shared",
    getForgeCheckDetails,
    getGithubCheckDetails: vi.fn(),
  };

  await expect(
    fetchBoundPullRequestCheckDetails({
      workspaceGit,
      transport: "forge",
      repoOwner: "getpaseo",
      repoName: "paseo",
      checkRunId: 42,
      changeRequestNumber: 99,
    }),
  ).resolves.toMatchObject({ output: { text: "runtime log attachment" } });
  expect(workspaceGit).toMatchObject({ workspaceId: "workspace-selected", cwd: "/shared" });
  expect(getForgeCheckDetails).toHaveBeenCalledWith({
    repoOwner: "getpaseo",
    repoName: "paseo",
    checkRunId: 42,
    workflowRunId: undefined,
    changeRequestNumber: 99,
  });
});
