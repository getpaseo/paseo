import type { AgentAttachment, GitHubSearchItem } from "@server/shared/messages";

export function buildGitHubAttachmentFromSearchItem(
  item: GitHubSearchItem | null,
): AgentAttachment | null {
  if (!item) {
    return null;
  }

  if (item.kind === "pr") {
    return {
      type: "github_pr",
      mimeType: "application/github-pr",
      number: item.number,
      title: item.title,
      url: item.url,
      ...(item.body ? { body: item.body } : {}),
      ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
      ...(item.headRefName ? { headRefName: item.headRefName } : {}),
    };
  }

  return {
    type: "github_issue",
    mimeType: "application/github-issue",
    number: item.number,
    title: item.title,
    url: item.url,
    ...(item.body ? { body: item.body } : {}),
  };
}
