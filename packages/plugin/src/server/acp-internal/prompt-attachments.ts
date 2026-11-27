import type { ContentBlock } from "@agentclientprotocol/sdk";
import { getForgeDefinitionOrNeutral } from "@getpaseo/protocol/forge-manifest";
import type { ProviderContent } from "../provider.js";

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

export function toAcpContentBlock(content: ProviderContent): ContentBlock {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", data: content.data, mimeType: content.mimeType };
    case "forge_change_request":
      return {
        type: "text",
        text: renderChangeRequestAttachment({
          forge: content.forge ?? "git",
          number: content.number,
          title: content.title,
          url: content.url,
          body: content.body,
          projectPath: content.projectPath,
          baseRefName: content.baseRefName,
          headRefName: content.headRefName,
        }),
      };
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_pr":
      return {
        type: "text",
        text: renderChangeRequestAttachment({
          forge: "github",
          number: content.number,
          title: content.title,
          url: content.url,
          body: content.body,
          baseRefName: content.baseRefName,
          headRefName: content.headRefName,
        }),
      };
    case "forge_issue":
      return {
        type: "text",
        text: renderIssueAttachment({
          forge: content.forge ?? "git",
          number: content.number,
          title: content.title,
          url: content.url,
          body: content.body,
          projectPath: content.projectPath,
        }),
      };
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_issue":
      return {
        type: "text",
        text: renderIssueAttachment({
          forge: "github",
          number: content.number,
          title: content.title,
          url: content.url,
          body: content.body,
        }),
      };
    case "review":
      return { type: "text", text: renderReviewAttachment(content) };
    case "uploaded_file":
      return {
        type: "text",
        text: [
          `Uploaded file: ${content.fileName}`,
          `Path: ${content.path}`,
          `MIME: ${content.mimeType}`,
          `Size: ${content.size} bytes`,
        ].join("\n"),
      };
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
  const forge = getForgeDefinitionOrNeutral(input.forge);
  const lines = [
    `${forge.displayName} ${forge.changeRequestAbbrev} ${forge.changeRequestNumberPrefix}${input.number}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) lines.push(`Project: ${input.projectPath}`);
  if (input.baseRefName) lines.push(`Base: ${input.baseRefName}`);
  if (input.headRefName) lines.push(`Head: ${input.headRefName}`);
  if (input.body) lines.push("", input.body);
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
  const forge = getForgeDefinitionOrNeutral(input.forge);
  const lines = [
    `${forge.displayName} Issue ${forge.issueNumberPrefix}${input.number}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) lines.push(`Project: ${input.projectPath}`);
  if (input.body) lines.push("", input.body);
  return lines.join("\n");
}

function renderReviewAttachment(attachment: Extract<ProviderContent, { type: "review" }>): string {
  const lines = [`Paseo review attachment (${attachment.mode})`, `CWD: ${attachment.cwd}`];
  if (attachment.baseRef) lines.push(`Base: ${attachment.baseRef}`);
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

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}
