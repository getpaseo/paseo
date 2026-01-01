import { promises as fs } from "fs";
import path from "path";

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
  mimeType?: string;
  size: number;
  modifiedAt: string;
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".css",
  ".scss",
  ".html",
  ".mjs",
  ".cjs",
  ".sh",
]);

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

  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const targetPath = path.join(directoryPath, dirent.name);
      const kind: ExplorerEntryKind = dirent.isDirectory()
        ? "directory"
        : "file";
      return buildEntryPayload({ root, targetPath, name: dirent.name, kind });
    })
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

  if (TEXT_EXTENSIONS.has(ext)) {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      ...basePayload,
      kind: "text",
      encoding: "utf-8",
      content,
      mimeType: TEXT_MIME_TYPES[ext] ?? DEFAULT_TEXT_MIME_TYPE,
    };
  }

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

  return {
    ...basePayload,
    kind: "binary",
    encoding: "none",
    mimeType: "application/octet-stream",
  };
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
  const mimeType = TEXT_EXTENSIONS.has(ext)
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
