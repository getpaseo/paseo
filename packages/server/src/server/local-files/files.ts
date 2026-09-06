import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  LOCAL_FILE_MAX_BYTES,
  LOCAL_FILES_MAX_BYTES,
  LOCAL_FILES_MAX_COUNT,
  type LocalFileError,
  type LocalFileInfo,
} from "@getpaseo/protocol/project-local-files";
import { runGitCommand } from "../../utils/run-git-command.js";
import { readPaseoConfigForEdit } from "../../utils/paseo-config-file.js";

export class LocalFileFailure extends Error {
  constructor(readonly code: LocalFileError) {
    super(code);
    this.name = "LocalFileFailure";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function resolveLocalFile(root: string, path: string): string {
  const parts = path.split("/");
  const invalid = parts.some(
    (part) =>
      !part ||
      part === "." ||
      part === ".." ||
      part.toLowerCase() === ".git" ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
  );
  const hasControl = Array.from(path).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  if (
    invalid ||
    hasControl ||
    /[\\:*?"<>|]/.test(path) ||
    path.length > 512 ||
    path.toLowerCase() === "paseo.json"
  ) {
    throw new LocalFileFailure("invalid_path");
  }
  const canonicalRoot = realpathSync(root);
  let current = canonicalRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new LocalFileFailure("unsupported");
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new LocalFileFailure("unsupported");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return current;
}

export async function assertIgnored(root: string, path: string): Promise<void> {
  const result = await runGitCommand(["check-ignore", "--quiet", "--", path], {
    cwd: root,
    acceptExitCodes: [0, 1],
    timeout: 5000,
  });
  // check-ignore deliberately excludes tracked files, even if a rule matches them.
  if (result.exitCode !== 0) throw new LocalFileFailure("not_ignored");
}

function readBytes(file: string): Buffer {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new LocalFileFailure("unsupported");
  if (info.size > LOCAL_FILE_MAX_BYTES) throw new LocalFileFailure("too_large");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new LocalFileFailure("unsupported");
    if (opened.size > LOCAL_FILE_MAX_BYTES) throw new LocalFileFailure("too_large");
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(fd);
    if (
      count !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new LocalFileFailure("changed");
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function revision(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileInfo(path: string, bytes: Buffer): LocalFileInfo {
  return { path, status: "ready", size: bytes.length, revision: revision(bytes) };
}

export async function inspectLocalFile(
  root: string,
  path: string,
  budget = LOCAL_FILE_MAX_BYTES,
): Promise<LocalFileInfo> {
  let size = 0;
  try {
    resolveLocalFile(root, path);
    await assertIgnored(root, path);
    const file = resolveLocalFile(root, path);
    const stats = lstatSync(file);
    size = stats.size;
    if (stats.isFile() && size > Math.min(budget, LOCAL_FILE_MAX_BYTES))
      throw new LocalFileFailure("too_large");
    const bytes = readBytes(file);
    return fileInfo(path, bytes);
  } catch (error) {
    if (isMissing(error)) return { path, status: "missing", size: 0, revision: null };
    const code = error instanceof LocalFileFailure ? error.code : "unavailable";
    let status: LocalFileInfo["status"] = "unavailable";
    if (code === "not_ignored" || code === "too_large" || code === "unsupported") status = code;
    if (code === "invalid_path") status = "unsupported";
    return { path, status, size, revision: null };
  }
}

export function configuredLocalFiles(root: string): string[] {
  const configPath = join(root, "paseo.json");
  if (existsSync(configPath)) {
    const info = lstatSync(configPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      throw new LocalFileFailure("invalid_config");
    }
  }
  const config = readPaseoConfigForEdit(root);
  if (!config.ok) throw new LocalFileFailure("invalid_config");
  return config.config?.worktree?.localFiles ?? [];
}

export async function inspectLocalFiles(root: string, paths?: string[]): Promise<LocalFileInfo[]> {
  const candidates =
    paths ??
    [
      ...new Set([
        ...configuredLocalFiles(root),
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
        ".dev.vars",
      ]),
    ].slice(0, LOCAL_FILES_MAX_COUNT);
  const files: LocalFileInfo[] = [];
  let total = 0;
  for (const path of candidates) {
    const file = await inspectLocalFile(root, path, LOCAL_FILES_MAX_BYTES - total);
    if (file.status === "ready") total += file.size;
    if (total > LOCAL_FILES_MAX_BYTES) {
      files.push({ ...file, status: "too_large", revision: null });
    } else {
      files.push(file);
    }
  }
  return files;
}

export async function readLocalFile(input: {
  root: string;
  path: string;
  expectedRevision: string;
}): Promise<Buffer> {
  resolveLocalFile(input.root, input.path);
  await assertIgnored(input.root, input.path);
  const bytes = readBytes(resolveLocalFile(input.root, input.path));
  if (revision(bytes) !== input.expectedRevision) throw new LocalFileFailure("changed");
  return bytes;
}

export async function importLocalFile(input: {
  root: string;
  path: string;
  expectedRevision: string | null;
  bytes: Buffer;
}): Promise<LocalFileInfo> {
  if (input.bytes.length > LOCAL_FILE_MAX_BYTES) throw new LocalFileFailure("too_large");
  resolveLocalFile(input.root, input.path);
  await assertIgnored(input.root, input.path);
  // Keep comparison and replacement synchronous: concurrent daemon sessions cannot
  // interleave two successful writes against the same expected revision.
  const target = resolveLocalFile(input.root, input.path);
  let currentRevision: string | null = null;
  try {
    currentRevision = revision(readBytes(target));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  // An acknowledged retry succeeds without replacing a newer, different file.
  const nextRevision = revision(input.bytes);
  if (currentRevision === nextRevision) return fileInfo(input.path, input.bytes);
  if (currentRevision !== input.expectedRevision) throw new LocalFileFailure("changed");

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), ".paseo-import-" + randomUUID());
  try {
    writeFileSync(temp, input.bytes, { flag: "wx", mode: 0o600 });
    if (input.expectedRevision === null) {
      // A hard link gives no-clobber publication, including against external writers.
      linkSync(temp, target);
    } else {
      renameSync(temp, target);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return fileInfo(input.path, input.bytes);
}

export function decodeLocalFile(data: string): Buffer {
  if (data.length > Math.ceil(LOCAL_FILE_MAX_BYTES / 3) * 4 || data.length % 4 !== 0) {
    throw new LocalFileFailure("invalid_data");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new LocalFileFailure("invalid_data");
  return bytes;
}

export function localFileError(error: unknown): LocalFileError {
  if (error instanceof LocalFileFailure) return error.code;
  if (isMissing(error)) return "missing";
  return "unavailable";
}

export async function materializeLocalFiles(
  sourceRoot: string,
  targetRoot: string,
  skipMissing = false,
): Promise<void> {
  if (resolve(sourceRoot) === resolve(targetRoot)) return;
  const paths = configuredLocalFiles(sourceRoot);
  let total = 0;
  for (const path of paths) {
    const target = await inspectLocalFile(targetRoot, path);
    if (target.status === "ready") continue;
    const source = await inspectLocalFile(sourceRoot, path);
    if (skipMissing && source.status === "missing") continue;
    if (source.status !== "ready" || source.revision === null) {
      throw new LocalFileFailure(source.status === "missing" ? "missing" : "unavailable");
    }
    total += source.size;
    if (total > LOCAL_FILES_MAX_BYTES) throw new LocalFileFailure("too_large");
    const bytes = await readLocalFile({
      root: sourceRoot,
      path,
      expectedRevision: source.revision,
    });
    await importLocalFile({ root: targetRoot, path, bytes, expectedRevision: null });
  }
}
