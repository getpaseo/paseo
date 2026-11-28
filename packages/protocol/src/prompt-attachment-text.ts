import type { z } from "zod";
import { getForgeDefinitionOrNeutral } from "./forge-manifest.js";
import type { AgentAttachmentSchema } from "./messages.js";

// Shared by built-in providers and the plugin ACP client so every agent reads attachments the same way.
// Accepts the schema input so plugin SDK attachments, whose forge is optional, render too.
type RenderableAttachment = z.input<typeof AgentAttachmentSchema>;

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

export function renderPromptAttachmentAsText(attachment: RenderableAttachment): string {
  switch (attachment.type) {
    case "forge_change_request": {
      return renderChangeRequestAttachment({
        forge: attachment.forge ?? "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        projectPath: attachment.projectPath,
        baseRefName: attachment.baseRefName,
        headRefName: attachment.headRefName,
      });
    }
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_pr": {
      return renderChangeRequestAttachment({
        forge: "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        baseRefName: attachment.baseRefName,
        headRefName: attachment.headRefName,
      });
    }
    case "forge_issue": {
      return renderIssueAttachment({
        forge: attachment.forge ?? "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        projectPath: attachment.projectPath,
      });
    }
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_issue": {
      return renderIssueAttachment({
        forge: "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
      });
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
    case "uploaded_file": {
      return [
        `Uploaded file: ${attachment.fileName}`,
        `Path: ${attachment.path}`,
        `MIME: ${attachment.mimeType}`,
        `Size: ${attachment.size} bytes`,
      ].join("\n");
    }
    default:
      throw new Error("unreachable");
  }
}

function renderChangeRequestAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} ${formatChangeRequestAbbrev(input.forge)} ${formatChangeRequestNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.baseRefName) {
    lines.push(`Base: ${input.baseRefName}`);
  }
  if (input.headRefName) {
    lines.push(`Head: ${input.headRefName}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function renderIssueAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} Issue ${formatIssueNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function formatForgeLabel(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).displayName;
}

function formatChangeRequestAbbrev(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).changeRequestAbbrev;
}

function formatChangeRequestNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).changeRequestNumberPrefix}${number}`;
}

function formatIssueNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).issueNumberPrefix}${number}`;
}

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}
