import type { WorkspaceGitClient } from "@/git/workspace-git";

type CheckDetailsClient = Pick<
  WorkspaceGitClient,
  "workspaceId" | "cwd" | "getForgeCheckDetails" | "getGithubCheckDetails"
>;

export async function fetchBoundPullRequestCheckDetails(input: {
  workspaceGit: CheckDetailsClient;
  transport: "forge" | "github";
  repoOwner: string;
  repoName: string;
  checkRunId?: number;
  workflowRunId?: number;
  changeRequestNumber: number;
}) {
  const request = {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    checkRunId: input.checkRunId,
    workflowRunId: input.workflowRunId,
    changeRequestNumber: input.changeRequestNumber,
  };
  const payload =
    input.transport === "forge"
      ? await input.workspaceGit.getForgeCheckDetails(request)
      : await input.workspaceGit.getGithubCheckDetails(request);
  if (!payload.success) {
    throw new Error(payload.error?.message ?? "Could not load check details");
  }
  return payload.details ?? null;
}
