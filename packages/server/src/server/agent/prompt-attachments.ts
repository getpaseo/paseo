import type { AgentAttachment } from "../../shared/messages.js";

export function renderPromptAttachmentAsText(attachment: AgentAttachment): string {
  switch (attachment.type) {
    case "github_pr": {
      const lines = [`GitHub PR #${attachment.number}: ${attachment.title}`, attachment.url];
      if (attachment.baseRefName) {
        lines.push(`Base: ${attachment.baseRefName}`);
      }
      if (attachment.headRefName) {
        lines.push(`Head: ${attachment.headRefName}`);
      }
      if (attachment.body) {
        lines.push("", attachment.body);
      }
      return lines.join("\n");
    }
    case "github_issue": {
      const lines = [`GitHub Issue #${attachment.number}: ${attachment.title}`, attachment.url];
      if (attachment.body) {
        lines.push("", attachment.body);
      }
      return lines.join("\n");
    }
  }
}

export function findGitHubPrAttachment(
  attachments: readonly AgentAttachment[] | undefined,
): Extract<AgentAttachment, { type: "github_pr" }> | null {
  if (!attachments) {
    return null;
  }
  return (
    attachments.find(
      (attachment): attachment is Extract<AgentAttachment, { type: "github_pr" }> =>
        attachment.type === "github_pr",
    ) ?? null
  );
}
