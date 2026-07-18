import { constants, promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import { expandUserPath, resolvePathFromBase } from "../path-utils.js";

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

export interface FileExplorerFileBytes {
  path: string;
  kind: ExplorerFileKind;
  encoding: "utf-8" | "binary";
  bytes: Uint8Array;
  mimeType: string;
  size: number;
  modifiedAt: string;
}

const TEXT_MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
};

const DEFAULT_TEXT_MIME_TYPE = "text/plain";
const FILE_TYPE_SAMPLE_BYTES = 8192;
const READ_FILE_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
const ACCESS_OUTSIDE_WORKSPACE_MESSAGE = "Access outside of workspace is not allowed";

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

interface ScopedPath {
  requestedPath: string;
  resolvedPath: string;
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
  const stats = await fs.stat(directoryPath.resolvedPath);

  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a directory");
  }

  const dirents = await fs.readdir(directoryPath.resolvedPath, { withFileTypes: true });

  const entriesWithNulls = await Promise.all(
    dirents.map(async (dirent) => {
      const targetPath = path.join(directoryPath.requestedPath, dirent.name);
      const kind: ExplorerEntryKind = dirent.isDirectory() ? "directory" : "file";
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
        if (isMissingEntryError(error) || isOutsideWorkspaceError(error)) {
          return null;
        }
        throw error;
      }
    }),
  );
  const entries = entriesWithNulls.filter((entry): entry is FileExplorerEntry => entry !== null);

  entries.sort((a, b) => {
    const modifiedComparison = new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    if (modifiedComparison !== 0) {
      return modifiedComparison;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    path: normalizeRelativePath({ root, targetPath: directoryPath.requestedPath }),
    entries,
  };
}

export async function readExplorerFile({
  root,
  relativePath,
}: ReadFileParams): Promise<FileExplorerFile> {
  const file = await readExplorerFileBytes({ root, relativePath });

  if (file.kind === "image") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "base64",
      content: Buffer.from(file.bytes).toString("base64"),
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
    };
  }

  if (file.kind === "binary") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "none",
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
    };
  }

  return {
    path: file.path,
    kind: file.kind,
    encoding: "utf-8",
    content: Buffer.from(file.bytes).toString("utf-8"),
    mimeType: file.mimeType,
    size: file.size,
    modifiedAt: file.modifiedAt,
  };
}

export async function readExplorerFileBytes({
  root,
  relativePath,
}: ReadFileParams): Promise<FileExplorerFileBytes> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    const basePayload = {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };

    const buffer = await handle.readFile();
    if (ext in IMAGE_MIME_TYPES) {
      return {
        ...basePayload,
        kind: "image",
        encoding: "binary",
        bytes: buffer,
        mimeType: IMAGE_MIME_TYPES[ext],
      };
    }

    if (isLikelyBinary(buffer)) {
      return {
        ...basePayload,
        kind: "binary",
        encoding: "binary",
        bytes: buffer,
        mimeType: "application/octet-stream",
      };
    }

    return {
      ...basePayload,
      kind: "text",
      encoding: "utf-8",
      bytes: buffer,
      mimeType: textMimeTypeForExtension(ext),
    };
  } finally {
    await handle.close();
  }
}

export interface CreateExplorerEntryParams {
  root: string;
  parentPath?: string;
  name: string;
  kind: ExplorerEntryKind;
}

export interface RenameExplorerEntryParams {
  root: string;
  path: string;
  newName: string;
}

export interface DeleteExplorerEntryParams {
  root: string;
  path: string;
}

export interface DuplicateExplorerEntryParams {
  root: string;
  path: string;
}

export async function createExplorerEntry({
  root,
  parentPath = ".",
  name,
  kind,
}: CreateExplorerEntryParams): Promise<FileExplorerEntry> {
  assertValidEntryName(name);

  const parent = await resolveScopedPath({ root, relativePath: parentPath });
  const parentStats = await fs.stat(parent.resolvedPath);
  if (!parentStats.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }

  const targetPath = path.join(parent.requestedPath, name);
  const scopedTarget = await resolveScopedPath({
    root,
    relativePath: normalizeRelativePath({ root, targetPath }),
  });

  if (await pathExists(scopedTarget.resolvedPath)) {
    throw new Error("An entry with that name already exists");
  }

  if (kind === "directory") {
    await fs.mkdir(scopedTarget.resolvedPath);
  } else {
    await fs.writeFile(scopedTarget.resolvedPath, "", { flag: "wx" });
  }

  return buildEntryPayload({
    root,
    targetPath: scopedTarget.requestedPath,
    name,
    kind,
  });
}

export async function renameExplorerEntry({
  root,
  path: relativePath,
  newName,
}: RenameExplorerEntryParams): Promise<FileExplorerEntry> {
  assertValidEntryName(newName);

  const source = await resolveScopedPath({ root, relativePath });
  const normalizedSource = normalizeRelativePath({ root, targetPath: source.requestedPath });
  if (normalizedSource === ".") {
    throw new Error("Cannot rename the workspace root");
  }

  const sourceStats = await fs.stat(source.resolvedPath);
  const kind: ExplorerEntryKind = sourceStats.isDirectory() ? "directory" : "file";

  const parentRequestedPath = path.dirname(source.requestedPath);
  const destinationPath = path.join(parentRequestedPath, newName);
  const destination = await resolveScopedPath({
    root,
    relativePath: normalizeRelativePath({ root, targetPath: destinationPath }),
  });

  if (await pathExists(destination.resolvedPath)) {
    throw new Error("An entry with that name already exists");
  }

  await fs.rename(source.resolvedPath, destination.resolvedPath);

  return buildEntryPayload({
    root,
    targetPath: destination.requestedPath,
    name: newName,
    kind,
  });
}

export async function deleteExplorerEntry({
  root,
  path: relativePath,
}: DeleteExplorerEntryParams): Promise<void> {
  const target = await resolveScopedPath({ root, relativePath });
  const normalized = normalizeRelativePath({ root, targetPath: target.requestedPath });
  if (normalized === ".") {
    throw new Error("Cannot delete the workspace root");
  }

  const stats = await fs.lstat(target.resolvedPath);
  if (stats.isDirectory()) {
    await fs.rm(target.resolvedPath, { recursive: true, force: false });
  } else {
    await fs.unlink(target.resolvedPath);
  }
}

export async function duplicateExplorerEntry({
  root,
  path: relativePath,
}: DuplicateExplorerEntryParams): Promise<FileExplorerEntry> {
  const source = await resolveScopedPath({ root, relativePath });
  const normalizedSource = normalizeRelativePath({ root, targetPath: source.requestedPath });
  if (normalizedSource === ".") {
    throw new Error("Cannot duplicate the workspace root");
  }

  const sourceStats = await fs.stat(source.resolvedPath);
  const kind: ExplorerEntryKind = sourceStats.isDirectory() ? "directory" : "file";
  const parentRequestedPath = path.dirname(source.requestedPath);
  const parent = await resolveScopedPath({
    root,
    relativePath: normalizeRelativePath({ root, targetPath: parentRequestedPath }),
  });

  const siblingNames = new Set(await fs.readdir(parent.resolvedPath));
  const duplicateName = allocateDuplicateName(path.basename(source.requestedPath), siblingNames);
  const destinationPath = path.join(parent.requestedPath, duplicateName);
  const destination = await resolveScopedPath({
    root,
    relativePath: normalizeRelativePath({ root, targetPath: destinationPath }),
  });

  if (kind === "directory") {
    await fs.cp(source.resolvedPath, destination.resolvedPath, { recursive: true });
  } else {
    await fs.copyFile(source.resolvedPath, destination.resolvedPath);
  }

  return buildEntryPayload({
    root,
    targetPath: destination.requestedPath,
    name: duplicateName,
    kind,
  });
}

export async function getDownloadableFileInfo({ root, relativePath }: ReadFileParams): Promise<{
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    let mimeType = "application/octet-stream";
    if (ext in IMAGE_MIME_TYPES) {
      mimeType = IMAGE_MIME_TYPES[ext];
    } else {
      const sample = Buffer.alloc(FILE_TYPE_SAMPLE_BYTES);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      const chunk = bytesRead < sample.length ? sample.subarray(0, bytesRead) : sample;
      if (!isLikelyBinary(chunk)) {
        mimeType = textMimeTypeForExtension(ext);
      }
    }

    return {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      absolutePath: filePath.resolvedPath,
      fileName: path.basename(filePath.requestedPath),
      mimeType,
      size: stats.size,
    };
  } finally {
    await handle.close();
  }
}

async function resolveScopedPath({
  root,
  relativePath = ".",
}: ScopedPathParams): Promise<ScopedPath> {
  const normalizedRoot = expandUserPath(root);
  const requestedPath = resolvePathFromBase(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, requestedPath);

  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
  }

  const realRoot = await fs.realpath(normalizedRoot);

  try {
    const realPath = await fs.realpath(requestedPath);
    const realRelative = path.relative(realRoot, realPath);
    if (realRelative !== "" && (realRelative.startsWith("..") || path.isAbsolute(realRelative))) {
      throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
    }
    return { requestedPath, resolvedPath: realPath };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { requestedPath, resolvedPath: requestedPath };
    }
    throw error;
  }
}

async function openFileForRead(filePath: string): Promise<FileHandle> {
  return fs.open(filePath, READ_FILE_OPEN_FLAGS);
}

async function buildEntryPayload({
  root,
  targetPath,
  name,
  kind,
}: EntryPayloadParams): Promise<FileExplorerEntry> {
  const entryPath = await resolveScopedPath({
    root,
    relativePath: normalizeRelativePath({ root, targetPath }),
  });
  const stats = await fs.stat(entryPath.resolvedPath);
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

function isOutsideWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === ACCESS_OUTSIDE_WORKSPACE_MESSAGE;
}

function assertValidEntryName(name: string): void {
  if (name.length === 0) {
    throw new Error("Name is required");
  }
  if (name === "." || name === "..") {
    throw new Error("Invalid entry name");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Invalid entry name");
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isMissingEntryError(error)) {
      return false;
    }
    throw error;
  }
}

function allocateDuplicateName(originalName: string, existingNames: Set<string>): string {
  const extension = path.extname(originalName);
  const baseName = path.basename(originalName, extension);
  const firstCandidate = `${baseName} copy${extension}`;
  if (!existingNames.has(firstCandidate)) {
    return firstCandidate;
  }

  let copyIndex = 2;
  while (true) {
    const candidate = `${baseName} copy ${copyIndex}${extension}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
    copyIndex += 1;
  }
}

function normalizeRelativePath({ root, targetPath }: { root: string; targetPath: string }): string {
  const normalizedRoot = expandUserPath(root);
  const normalizedTarget = expandUserPath(targetPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function textMimeTypeForExtension(ext: string): string {
  return TEXT_MIME_TYPES[ext] ?? DEFAULT_TEXT_MIME_TYPE;
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (let idx = 0; idx < buffer.length; idx += 1) {
    const byte = buffer[idx];
    if (byte === 0) {
      return true;
    }

    const isControl =
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13; // carriage return

    if (isControl || byte === 127) {
      suspicious += 1;
    }
  }

  return suspicious / buffer.length > 0.3;
}
