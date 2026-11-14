import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { canonicalPath } from "./process.js";
import { AntigravityError } from "./wire.js";

export interface EncodedPrompt {
  text: string;
  nativeText: string;
}

export class PromptFiles {
  private directory: string | null = null;
  private readonly extraDirectories = new Set<string>();

  get directoryPath(): string | null {
    return this.directory;
  }

  get additionalDirectories(): readonly string[] {
    return this.directory ? [...this.extraDirectories, this.directory] : [...this.extraDirectories];
  }

  async encode(prompt: ProviderPrompt): Promise<EncodedPrompt> {
    if (prompt.delivery === "steer" || prompt.outputSchema !== undefined) {
      throw new AntigravityError(
        "Antigravity supports standard messages and slash commands only",
        "UNSUPPORTED_PROMPT",
      );
    }
    if (prompt.input.type === "command") {
      const args = prompt.input.arguments.trim();
      const commandText = args ? `/${prompt.input.name} ${args}` : `/${prompt.input.name}`;
      return { text: commandText, nativeText: commandText };
    }

    const validated = prompt.input.content.map((part) =>
      part.type === "image"
        ? { kind: "image" as const, part, extension: imageExtension(part.mimeType) }
        : { kind: "other" as const, part },
    );

    const text: string[] = [];
    const native: string[] = [];
    for (const item of validated) {
      if (item.kind === "image") {
        const file = await this.writeImage(item.part.data, item.extension);
        text.push(`[Image: ${path.basename(file)}]`);
        native.push(`Attached image: ${file}`);
      } else {
        const formatted = this.formatPart(item.part);
        text.push(formatted.text);
        native.push(formatted.nativeText);
      }
    }
    return { text: text.join("\n"), nativeText: native.join("\n") };
  }

  async close(): Promise<void> {
    const directory = this.directory;
    this.directory = null;
    this.extraDirectories.clear();
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private formatPart(part: Exclude<ProviderContent, { type: "image" }>): EncodedPrompt {
    switch (part.type) {
      case "text":
        return formatTextPart(part);
      case "uploaded_file":
        this.extraDirectories.add(canonicalPath(path.dirname(part.path)));
        return {
          text: `[File: ${part.fileName}]`,
          nativeText: `Attached file (${part.fileName}, ${part.mimeType}): ${part.path}`,
        };
      case "github_pr":
      case "forge_change_request":
        return formatPullRequestPart(part);
      case "github_issue":
      case "forge_issue":
        return formatIssuePart(part);
      case "review":
        return formatReviewPart(part);
    }
  }

  private async writeImage(data: string, extension: string): Promise<string> {
    if (!this.directory) {
      const rawDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-images-"));
      await chmod(rawDir, 0o700);
      this.directory = await realpath(rawDir);
    }
    const file = path.join(this.directory, `${randomUUID()}.${extension}`);
    await writeFile(file, Buffer.from(data, "base64"), { mode: 0o600 });
    return file;
  }
}

function formatTextPart(part: Extract<ProviderContent, { type: "text" }>): EncodedPrompt {
  if (!("mimeType" in part)) return { text: part.text, nativeText: part.text };
  const title = part.title?.trim() || part.externalResource?.title || "Context";
  const url = part.externalResource?.url ? ` (${part.externalResource.url})` : "";
  const rendered = `[${title}${url}]\n${part.text}`;
  return { text: rendered, nativeText: rendered };
}

function formatPullRequestPart(
  part: Extract<ProviderContent, { type: "github_pr" | "forge_change_request" }>,
): EncodedPrompt {
  const refs =
    part.headRefName && part.baseRefName ? ` (${part.headRefName} -> ${part.baseRefName})` : "";
  const header = `Pull Request #${part.number}: ${part.title}${refs}\nURL: ${part.url}`;
  const full = part.body?.trim() ? `${header}\n\n${part.body.trim()}` : header;
  return { text: `[PR #${part.number}: ${part.title}]`, nativeText: full };
}

function formatIssuePart(
  part: Extract<ProviderContent, { type: "github_issue" | "forge_issue" }>,
): EncodedPrompt {
  const header = `Issue #${part.number}: ${part.title}\nURL: ${part.url}`;
  const full = part.body?.trim() ? `${header}\n\n${part.body.trim()}` : header;
  return { text: `[Issue #${part.number}: ${part.title}]`, nativeText: full };
}

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

function formatReviewPart(part: Extract<ProviderContent, { type: "review" }>): EncodedPrompt {
  const scope =
    part.mode === "base" && part.baseRef ? `diff against ${part.baseRef}` : "uncommitted changes";
  const lines = [`Code review (${scope} in ${part.cwd}):`];
  part.comments.forEach((comment, index) => {
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
  return {
    text: `[Review: ${part.comments.length} comment(s)]`,
    nativeText: lines.join("\n"),
  };
}

function imageExtension(mimeType: string): string {
  const match = /^image\/([a-z0-9][a-z0-9.+-]*)$/i.exec(mimeType);
  if (!match) {
    throw new AntigravityError(
      `Expected an image MIME type, received ${mimeType}`,
      "INVALID_IMAGE_MIME",
    );
  }
  const subtype = match[1]!.toLowerCase();
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  return subtype.replace(/[^a-z0-9]/g, "");
}
