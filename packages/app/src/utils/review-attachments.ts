import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";

export function buildForgeAttachmentFromSearchItem(
  item: ForgeSearchItem | null,
): AgentAttachment | null {
  if (!item) {
    return null;
  }

  if (item.kind === "change_request") {
    return {
      type: "forge_change_request",
      mimeType: "application/paseo-forge-change-request",
      forge: item.forge ?? "github",
      number: item.number,
      title: item.title,
      url: item.url,
      ...(item.body ? { body: item.body } : {}),
      ...(item.projectPath ? { projectPath: item.projectPath } : {}),
      ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
      ...(item.headRefName ? { headRefName: item.headRefName } : {}),
    };
  }

  return {
    type: "forge_issue",
    mimeType: "application/paseo-forge-issue",
    forge: item.forge ?? "github",
    number: item.number,
    title: item.title,
    url: item.url,
    ...(item.body ? { body: item.body } : {}),
    ...(item.projectPath ? { projectPath: item.projectPath } : {}),
  };
}

export const buildGitHubAttachmentFromSearchItem = buildForgeAttachmentFromSearchItem;

export function buildLegacyGitHubAttachmentFromSearchItem(
  item: ForgeSearchItem | null,
): AgentAttachment | null {
  if (!item) {
    return null;
  }

  if (item.kind === "change_request") {
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
