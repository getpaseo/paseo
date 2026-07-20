import { rmSync } from "node:fs";
import path from "node:path";
import type { AssistantMemoryFiles } from "@getpaseo/protocol/messages";
import { writePrivateFileAtomicSync } from "../private-files.js";

const MEMORY_DETAIL_CHUNK_TARGET_CHARS = 4_000;
const MEMORY_SUMMARY_MAX_HEADINGS = 12;
const MEMORY_SUMMARY_MAX_DETAIL_FILES = 30;
const GENERATED_SUMMARY_END_SENTENCE =
  "When you need exact memories, open the specific detail file path from the index instead of relying on this summary.";
const GENERATED_SUMMARY_SIGNATURE =
  "Only this summary is included in the first agent prompt. The full memory is stored in detail files; read the relevant detail file only when the task needs more specific context.";
const GENERATED_SUMMARY_HEADING_KEYS = new Set([
  "assistant memory summary",
  "memory headings",
  "detail file index",
]);

export interface MaterializedAssistantMemoryFiles {
  memorySummary: string;
  memoryFiles: AssistantMemoryFiles;
}

export interface AssistantMemoryDetailFileEdit {
  id: string;
  content: string;
}

interface MemoryChunk {
  id: string;
  title: string;
  content: string;
}

function emptyMemoryFiles(): MaterializedAssistantMemoryFiles {
  return {
    memorySummary: "",
    memoryFiles: { summaryPath: "", detailFiles: [] },
  };
}

function normalizeMemory(memory: string): string {
  return cleanAssistantMemorySource(memory);
}

function normalizeEditedMemoryFileContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "_");
  return sanitized.length > 0 ? sanitized : "assistant";
}

function assistantMemoryDirectory(paseoHome: string, assistantId: string): string {
  return path.join(paseoHome, "assistants", sanitizePathSegment(assistantId), "memory");
}

export function removeAssistantMemoryFiles(paseoHome: string, assistantId: string): void {
  rmSync(assistantMemoryDirectory(paseoHome, assistantId), { recursive: true, force: true });
}

function truncateSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripMarkdownPrefix(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function normalizeKnowledgeType(value: string): string {
  return stripMarkdownPrefix(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function getLeadingHeadingTitle(content: string): string | null {
  return content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || null;
}

function stripLeadingHeading(content: string): string {
  return content.replace(/^#{1,6}\s+.+(?:\n|$)/, "").trim();
}

function normalizeMemoryDedupKey(value: string): string {
  return stripMarkdownPrefix(value)
    .replace(
      /^[（(]?(?:请)?(?:首先|先要|需要先|先|第一步|第[一二三四五六七八九十]+步|步骤[一二三四五六七八九十\d]+)[）)]?[：:，,、。.\s]*/u,
      "",
    )
    .replace(/[\s"'“”‘’，,。.;；:：、!?！？()[\]（）【】]+/g, "")
    .trim()
    .toLowerCase();
}

function getListItemDedupKey(line: string): string | null {
  const listItem = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+\S)\s*$/);
  if (!listItem) {
    return null;
  }
  const key = normalizeMemoryDedupKey(listItem[1] ?? "");
  return key.length > 0 ? key : null;
}

function renumberOrderedListItems(content: string): string {
  let nextNumber: number | null = null;
  return content
    .split("\n")
    .map((line) => {
      const orderedListItem = line.match(/^(\s*)\d+([.)]\s+)(.+)$/);
      if (orderedListItem) {
        nextNumber = nextNumber === null ? 1 : nextNumber + 1;
        return `${orderedListItem[1]}${nextNumber}${orderedListItem[2]}${orderedListItem[3]}`;
      }
      if (line.trim().length === 0) {
        return line;
      }
      nextNumber = null;
      return line;
    })
    .join("\n");
}

function dedupeRepeatedMemoryEntries(content: string): string {
  const blocks = content
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/g)
    .map((block) => block.split("\n"));
  const preferredListItemByKey = new Map<
    string,
    { score: number; blockIndex: number; lineIndex: number }
  >();

  blocks.forEach((lines, blockIndex) => {
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    const listItemCount = nonEmptyLines.filter((line) => getListItemDedupKey(line)).length;
    const hasContextLine = nonEmptyLines.some((line) => !getListItemDedupKey(line));
    const blockScore = (hasContextLine ? 2 : 0) + (listItemCount > 1 ? 1 : 0);

    lines.forEach((line, lineIndex) => {
      const key = getListItemDedupKey(line);
      if (!key) {
        return;
      }
      const current = preferredListItemByKey.get(key);
      if (!current || blockScore > current.score) {
        preferredListItemByKey.set(key, { score: blockScore, blockIndex, lineIndex });
      }
    });
  });

  const dedupedLineBlocks = blocks
    .map((lines, blockIndex) =>
      lines.filter((line, lineIndex) => {
        const key = getListItemDedupKey(line);
        if (!key) {
          return true;
        }
        const preferred = preferredListItemByKey.get(key);
        return preferred?.blockIndex === blockIndex && preferred.lineIndex === lineIndex;
      }),
    )
    .map((lines) => lines.join("\n").trim())
    .filter((block) => block.length > 0);

  const seenBlocks = new Set<string>();
  const dedupedBlocks = dedupedLineBlocks.filter((block) => {
    const key = normalizeMemoryDedupKey(block);
    if (!key) {
      return true;
    }
    if (seenBlocks.has(key)) {
      return false;
    }
    seenBlocks.add(key);
    return true;
  });

  return renumberOrderedListItems(dedupedBlocks.join("\n\n"));
}

function mergeMemorySections(title: string | null, sections: string[]): string {
  const body = dedupeRepeatedMemoryEntries(
    sections
      .map((section) => (title ? stripLeadingHeading(section) : section.trim()))
      .filter((section) => section.length > 0)
      .join("\n\n"),
  );
  if (!title) {
    return body;
  }
  return [`# ${title}`, body].filter((part) => part.trim().length > 0).join("\n\n");
}

function stripRedundantLeadingChunkHeading(content: string, title: string): string {
  const leadingTitle = getLeadingHeadingTitle(content);
  if (leadingTitle && normalizeKnowledgeType(leadingTitle) === normalizeKnowledgeType(title)) {
    return stripLeadingHeading(content);
  }
  return content.trim();
}

function stripGeneratedMemorySummaryBlocks(memory: string): string {
  const lines = memory.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]?.trim() ?? "";
    if (line === "# Assistant memory summary") {
      let cursor = index + 1;
      let hasGeneratedSignature = false;
      let foundGeneratedEnd = false;
      for (; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor] ?? "";
        if (candidate.includes(GENERATED_SUMMARY_SIGNATURE)) {
          hasGeneratedSignature = true;
        }
        if (candidate.trim() === GENERATED_SUMMARY_END_SENTENCE) {
          foundGeneratedEnd = true;
          cursor += 1;
          break;
        }
      }
      if (hasGeneratedSignature && foundGeneratedEnd) {
        index = cursor;
        continue;
      }
    }

    output.push(lines[index] ?? "");
    index += 1;
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unwrapGeneratedDetailFileContent(content: string): string {
  const lines = content.trim().split("\n");
  const separatorIndex = lines.findIndex(
    (line, index) => index > 0 && index <= 8 && line.trim() === "---",
  );
  if (separatorIndex < 0) {
    return content.trim();
  }

  const wrapperHeader = lines.slice(0, separatorIndex).join("\n");
  if (
    /^Assistant ID:\s+\S+/m.test(wrapperHeader) &&
    /^Detail ID:\s+\S+/m.test(wrapperHeader) &&
    /^Chunk:\s+\d+\/\d+/m.test(wrapperHeader)
  ) {
    return lines
      .slice(separatorIndex + 1)
      .join("\n")
      .trim();
  }

  return content.trim();
}

function isGeneratedSummaryMetadataSection(content: string): boolean {
  const title = getLeadingHeadingTitle(content);
  if (!title) {
    return false;
  }
  const key = normalizeKnowledgeType(title);
  if (!GENERATED_SUMMARY_HEADING_KEYS.has(key)) {
    return false;
  }
  return (
    content.includes(GENERATED_SUMMARY_SIGNATURE) ||
    content.includes("Memory detail files:") ||
    content.includes("Path: ") ||
    content.includes(GENERATED_SUMMARY_END_SENTENCE)
  );
}

export function cleanAssistantMemorySource(memory: string): string {
  const normalized = memory.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return "";
  }
  const withoutGeneratedSummary = stripGeneratedMemorySummaryBlocks(normalized);
  return splitMemoryIntoUnits(withoutGeneratedSummary).join("\n\n").trim();
}

function inferChunkTitle(content: string, fallbackIndex: number): string {
  const heading = getLeadingHeadingTitle(content);
  if (heading?.trim()) {
    return truncateSingleLine(heading, 80);
  }
  const firstLine = content
    .split("\n")
    .map((line) => stripMarkdownPrefix(line))
    .find((line) => line.length > 0);
  if (firstLine) {
    return truncateSingleLine(firstLine, 80);
  }
  return `Memory details ${fallbackIndex + 1}`;
}

function splitLargeText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const paragraphBreak = window.lastIndexOf("\n\n");
    const lineBreak = window.lastIndexOf("\n");
    const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("。"));
    let splitAt = maxChars;
    if (paragraphBreak > maxChars * 0.45) {
      splitAt = paragraphBreak + 2;
    } else if (lineBreak > maxChars * 0.45) {
      splitAt = lineBreak + 1;
    } else if (sentenceBreak > maxChars * 0.45) {
      splitAt = sentenceBreak + 1;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function splitMemoryIntoUnits(memory: string): string[] {
  const rawHeadingSections = memory
    .split(/\n(?=#{1,6}\s+\S)/g)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  const hasHeadingSections = rawHeadingSections.some((section) => getLeadingHeadingTitle(section));
  if (hasHeadingSections) {
    const orderedKeys: string[] = [];
    const sectionsByType = new Map<string, { title: string | null; sections: string[] }>();

    rawHeadingSections
      .map((section) => unwrapGeneratedDetailFileContent(section))
      .filter((section) => section.length > 0 && !isGeneratedSummaryMetadataSection(section))
      .forEach((section, index) => {
        const title = getLeadingHeadingTitle(section);
        const key = title ? normalizeKnowledgeType(title) : `__memory_section_${index}`;
        const existing = sectionsByType.get(key);
        if (!existing) {
          orderedKeys.push(key);
          sectionsByType.set(key, { title, sections: [section] });
          return;
        }

        if (section.length > 0) {
          existing.sections.push(section);
        }
      });

    return orderedKeys
      .map((key) => {
        const group = sectionsByType.get(key);
        return group ? mergeMemorySections(group.title, group.sections) : "";
      })
      .filter((section) => section.length > 0);
  }
  const dedupedMemory = dedupeRepeatedMemoryEntries(memory);
  const paragraphs = dedupedMemory
    .split(/\n{2,}/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.length > 0 ? paragraphs : [dedupedMemory];
}

function splitMemoryIntoChunks(memory: string): MemoryChunk[] {
  const units = splitMemoryIntoUnits(memory);
  const preserveUnitBoundaries = units.some((unit) => getLeadingHeadingTitle(unit));
  const rawChunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim().length > 0) {
      rawChunks.push(current.trim());
      current = "";
    }
  };

  for (const unit of units) {
    if (preserveUnitBoundaries) {
      pushCurrent();
      if (unit.length > MEMORY_DETAIL_CHUNK_TARGET_CHARS) {
        rawChunks.push(...splitLargeText(unit, MEMORY_DETAIL_CHUNK_TARGET_CHARS));
      } else {
        rawChunks.push(unit);
      }
      continue;
    }

    if (unit.length > MEMORY_DETAIL_CHUNK_TARGET_CHARS) {
      pushCurrent();
      rawChunks.push(...splitLargeText(unit, MEMORY_DETAIL_CHUNK_TARGET_CHARS));
      continue;
    }
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length > MEMORY_DETAIL_CHUNK_TARGET_CHARS) {
      pushCurrent();
      current = unit;
    } else {
      current = candidate;
    }
  }
  pushCurrent();

  return rawChunks.map((content, index) => ({
    id: `detail-${String(index + 1).padStart(3, "0")}`,
    title: inferChunkTitle(content, index),
    content,
  }));
}

function extractHeadings(memory: string): string[] {
  const headings: string[] = [];
  const seen = new Set<string>();

  for (const match of memory.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = truncateSingleLine(match[1] ?? "", 100);
    const key = normalizeKnowledgeType(heading);
    if (!heading || GENERATED_SUMMARY_HEADING_KEYS.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    headings.push(heading);
    if (headings.length >= MEMORY_SUMMARY_MAX_HEADINGS) {
      break;
    }
  }

  return headings;
}

function buildMemorySummary(input: {
  assistantId: string;
  memory: string;
  summaryPath: string;
  detailFiles: AssistantMemoryFiles["detailFiles"];
}): string {
  const headings = extractHeadings(input.memory);
  const visibleDetailFiles = input.detailFiles.slice(0, MEMORY_SUMMARY_MAX_DETAIL_FILES);
  const omittedDetailFiles = input.detailFiles.length - visibleDetailFiles.length;
  const detailIndex = visibleDetailFiles
    .map(
      (file, index) =>
        `${index + 1}. ${file.id} — ${file.title} (${file.charCount} chars)\n   Path: ${file.path}`,
    )
    .join("\n");
  const headingIndex = headings.map((heading) => `- ${heading}`).join("\n");

  return [
    "# Assistant memory summary",
    "Only this summary is included in the first agent prompt. The full memory is stored in detail files; read the relevant detail file only when the task needs more specific context.",
    `Assistant ID: ${input.assistantId}`,
    `Summary file: ${input.summaryPath}`,
    `Memory detail files: ${input.detailFiles.length}`,
    headings.length > 0 ? `\n## Memory headings\n${headingIndex}` : null,
    detailIndex.length > 0
      ? `\n## Detail file index\n${detailIndex}${
          omittedDetailFiles > 0
            ? `\n... ${omittedDetailFiles} more detail files omitted from this prompt.`
            : ""
        }`
      : null,
    "\nWhen you need exact memories, open the specific detail file path from the index instead of relying on this summary.",
  ]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n\n");
}

export function materializeAssistantMemoryFiles(input: {
  paseoHome: string;
  assistantId: string;
  memoryEnabled: boolean;
  memory: string;
}): MaterializedAssistantMemoryFiles {
  const memoryDirectory = assistantMemoryDirectory(input.paseoHome, input.assistantId);
  const normalizedMemory = normalizeMemory(input.memory);
  if (!input.memoryEnabled || normalizedMemory.length === 0) {
    removeAssistantMemoryFiles(input.paseoHome, input.assistantId);
    return emptyMemoryFiles();
  }

  rmSync(memoryDirectory, { recursive: true, force: true });
  const detailsDirectory = path.join(memoryDirectory, "details");
  const summaryPath = path.join(memoryDirectory, "summary.md");
  const chunks = splitMemoryIntoChunks(normalizedMemory);
  const detailFiles = chunks.map((chunk, index) => {
    const filePath = path.join(detailsDirectory, `${chunk.id}.md`);
    const detailBody = stripRedundantLeadingChunkHeading(chunk.content, chunk.title);
    const fileContent = [
      `# ${chunk.title}`,
      `Assistant ID: ${input.assistantId}`,
      `Detail ID: ${chunk.id}`,
      `Chunk: ${index + 1}/${chunks.length}`,
      "---",
      detailBody,
    ].join("\n\n");
    writePrivateFileAtomicSync(filePath, fileContent);
    return {
      id: chunk.id,
      title: chunk.title,
      path: filePath,
      charCount: detailBody.length,
      content: fileContent,
    };
  });
  const memorySummary = buildMemorySummary({
    assistantId: input.assistantId,
    memory: normalizedMemory,
    summaryPath,
    detailFiles,
  });
  writePrivateFileAtomicSync(summaryPath, memorySummary);

  return {
    memorySummary,
    memoryFiles: {
      summaryPath,
      detailFiles,
    },
  };
}

export function applyAssistantMemoryFileEdits(input: {
  memorySummary: string;
  memoryFiles: AssistantMemoryFiles;
  summaryContent?: string;
  detailFileEdits?: AssistantMemoryDetailFileEdit[];
}): MaterializedAssistantMemoryFiles {
  const summaryContent =
    input.summaryContent === undefined
      ? input.memorySummary
      : normalizeEditedMemoryFileContent(input.summaryContent);
  if (input.memoryFiles.summaryPath) {
    writePrivateFileAtomicSync(input.memoryFiles.summaryPath, summaryContent);
  }

  const detailEdits = new Map(
    (input.detailFileEdits ?? []).map((edit) => [
      edit.id,
      normalizeEditedMemoryFileContent(edit.content),
    ]),
  );
  const unknownDetailIds = new Set(detailEdits.keys());
  const detailFiles = input.memoryFiles.detailFiles.map((file, index) => {
    if (!detailEdits.has(file.id)) {
      if (file.path && file.content !== undefined) {
        writePrivateFileAtomicSync(file.path, file.content);
      }
      return file;
    }
    unknownDetailIds.delete(file.id);
    const content = detailEdits.get(file.id)!;
    writePrivateFileAtomicSync(file.path, content);
    return {
      ...file,
      title: inferChunkTitle(content, index),
      charCount: content.length,
      content,
    };
  });

  if (unknownDetailIds.size > 0) {
    throw new Error(`Memory detail file not found: ${Array.from(unknownDetailIds).join(", ")}`);
  }

  return {
    memorySummary: summaryContent,
    memoryFiles: {
      ...input.memoryFiles,
      detailFiles,
    },
  };
}
