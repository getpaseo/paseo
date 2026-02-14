import { promises as fs } from "fs";
import path from "path";
import {
  highlightCode,
  isLanguageSupported,
  type HighlightToken,
} from "../utils/syntax-highlighter.js";
import { isKnownTextFilename } from "../utils/language-registry.js";

export type ExplorerEntryKind = "file" | "directory";
export type ExplorerFileKind = "text" | "image" | "binary";
export type ExplorerEncoding = "utf-8" | "base64" | "none";

export interface ListDirectoryParams {
  root: string;
  relativePath?: string;
}

export interface ReadFileParams {
  root: string;
  relativePath: string;
}

export interface FileExplorerEntry {
  name: string;
  path: string;
  kind: ExplorerEntryKind;
  size: number;
  modifiedAt: string;
}

export interface FileExplorerDirectory {
  path: string;
  entries: FileExplorerEntry[];
}

export interface FileExplorerFile {
  path: string;
  kind: ExplorerFileKind;
  encoding: ExplorerEncoding;
  content?: string;
  tokens?: HighlightToken[][];
  mimeType?: string;
  size: number;
  modifiedAt: string;
}

const PREVIEW_HIGHLIGHT_MAX_BYTES = 200 * 1024;
const BINARY_SNIFF_MAX_BYTES = 4096;
const BINARY_CONTROL_CHAR_RATIO_THRESHOLD = 0.3;

const TEXT_MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
};

const DEFAULT_TEXT_MIME_TYPE = "text/plain";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

interface ScopedPathParams {
  root: string;
  relativePath?: string;
}

interface EntryPayloadParams {
  root: string;
  targetPath: string;
  name: string;
  kind: ExplorerEntryKind;
}

export async function listDirectoryEntries({
  root,
  relativePath = ".",
}: ListDirectoryParams): Promise<FileExplorerDirectory> {
  const directoryPath = await resolveScopedPath({ root, relativePath });
  const stats = await fs.stat(directoryPath);

  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a directory");
  }

  const dirents = await fs.readdir(directoryPath, { withFileTypes: true });

  const entriesWithNulls = await Promise.all(
    dirents.map(async (dirent) => {
      const targetPath = path.join(directoryPath, dirent.name);
      const kind: ExplorerEntryKind = dirent.isDirectory()
        ? "directory"
        : "file";
      try {
        return await buildEntryPayload({
          root,
          targetPath,
          name: dirent.name,
          kind,
        });
      } catch (error) {
        // Directories can contain dangling links (e.g. AGENTS.md -> CLAUDE.md).
        // Skip entries whose targets disappeared instead of failing the whole listing.
        if (isMissingEntryError(error)) {
          return null;
        }
        throw error;
      }
    })
  );
  const entries = entriesWithNulls.filter(
    (entry): entry is FileExplorerEntry => entry !== null
  );

  entries.sort((a, b) => {
    const modifiedComparison =
      new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    if (modifiedComparison !== 0) {
      return modifiedComparison;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    path: normalizeRelativePath({ root, targetPath: directoryPath }),
    entries,
  };
}

export async function readExplorerFile({
  root,
  relativePath,
}: ReadFileParams): Promise<FileExplorerFile> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  const ext = path.extname(filePath).toLowerCase();
  const basePayload = {
    path: normalizeRelativePath({ root, targetPath: filePath }),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };

  if (ext in IMAGE_MIME_TYPES) {
    const buffer = await fs.readFile(filePath);
    return {
      ...basePayload,
      kind: "image",
      encoding: "base64",
      content: buffer.toString("base64"),
      mimeType: IMAGE_MIME_TYPES[ext],
    };
  }

  if (isKnownTextFilename(filePath)) {
    const content = await fs.readFile(filePath, "utf-8");
    return buildTextFilePayload({ ...basePayload, ext, content });
  }

  const sample = await readFileHead(filePath, BINARY_SNIFF_MAX_BYTES);
  if (isLikelyBinary(sample)) {
    return {
      ...basePayload,
      kind: "binary",
      encoding: "none",
      mimeType: "application/octet-stream",
    };
  }

  const content = await fs.readFile(filePath, "utf-8");
  return buildTextFilePayload({ ...basePayload, ext, content });
}

export async function getDownloadableFileInfo({
  root,
  relativePath,
}: ReadFileParams): Promise<{
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = isKnownTextFilename(filePath)
    ? TEXT_MIME_TYPES[ext] ?? DEFAULT_TEXT_MIME_TYPE
    : ext in IMAGE_MIME_TYPES
      ? IMAGE_MIME_TYPES[ext]
      : "application/octet-stream";

  return {
    path: normalizeRelativePath({ root, targetPath: filePath }),
    absolutePath: filePath,
    fileName: path.basename(filePath),
    mimeType,
    size: stats.size,
  };
}

async function resolveScopedPath({
  root,
  relativePath = ".",
}: ScopedPathParams): Promise<string> {
  const normalizedRoot = path.resolve(root);
  const requestedPath = path.resolve(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, requestedPath);

  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return requestedPath;
  }

  throw new Error("Access outside of agent workspace is not allowed");
}

async function buildEntryPayload({
  root,
  targetPath,
  name,
  kind,
}: EntryPayloadParams): Promise<FileExplorerEntry> {
  const stats = await fs.stat(targetPath);
  return {
    name,
    path: normalizeRelativePath({ root, targetPath }),
    kind,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function normalizeRelativePath({
  root,
  targetPath,
}: {
  root: string;
  targetPath: string;
}): string {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(targetPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

async function readFileHead(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isLikelyBinary(sample: Buffer): boolean {
  if (sample.length === 0) {
    return false;
  }

  let controlBytes = 0;
  for (const value of sample.values()) {
    if (value === 0) {
      return true;
    }

    const isPrintableAscii = value >= 32 && value <= 126;
    const isCommonWhitespace = value === 9 || value === 10 || value === 13;
    const isExtendedUtf8Byte = value >= 128;
    if (!isPrintableAscii && !isCommonWhitespace && !isExtendedUtf8Byte) {
      controlBytes += 1;
    }
  }

  return controlBytes / sample.length > BINARY_CONTROL_CHAR_RATIO_THRESHOLD;
}

function buildTextFilePayload({
  path: filePath,
  size,
  modifiedAt,
  ext,
  content,
}: {
  path: string;
  size: number;
  modifiedAt: string;
  ext: string;
  content: string;
}): FileExplorerFile {
  const shouldTokenize =
    size <= PREVIEW_HIGHLIGHT_MAX_BYTES && isLanguageSupported(filePath);

  return {
    path: filePath,
    kind: "text",
    encoding: "utf-8",
    content,
    tokens: shouldTokenize ? highlightCode(content, filePath) : undefined,
    mimeType: TEXT_MIME_TYPES[ext] ?? DEFAULT_TEXT_MIME_TYPE,
    size,
    modifiedAt,
  };
}
