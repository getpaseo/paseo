import type { AgentAttachment } from "../../shared/messages.js";

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

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
    case "text": {
      return attachment.text;
    }
    case "review": {
      const lines = [`Paseo review attachment (${attachment.mode})`, `CWD: ${attachment.cwd}`];
      if (attachment.baseRef) {
        lines.push(`Base: ${attachment.baseRef}`);
      }
      attachment.comments.forEach((comment, index) => {
        lines.push(
          "",
          `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
          comment.body,
          comment.context.hunkHeader,
        );
        const target = comment.context.targetLine;
        for (const line of comment.context.lines) {
          const isTarget =
            line.oldLineNumber === target.oldLineNumber &&
            line.newLineNumber === target.newLineNumber &&
            line.type === target.type &&
            line.content === target.content;
          const prefix = isTarget ? "> " : "  ";
          const oldLn = padLineNumber(line.oldLineNumber);
          const newLn = padLineNumber(line.newLineNumber);
          lines.push(`${prefix}${oldLn} ${newLn} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`);
        }
      });
      return lines.join("\n");
    }
    default:
      throw new Error("unreachable");
  }
}

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

export function buildAgentBranchNameSeed(
  firstAgentContext: { prompt?: string; attachments?: readonly AgentAttachment[] } | undefined,
): string | undefined {
  if (!firstAgentContext) {
    return undefined;
  }
  const parts: string[] = [];
  const prompt = firstAgentContext.prompt?.trim();
  if (prompt) {
    parts.push(prompt);
  }
  for (const attachment of firstAgentContext.attachments ?? []) {
    const rendered = renderPromptAttachmentAsText(attachment).trim();
    if (rendered) {
      parts.push(rendered);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
