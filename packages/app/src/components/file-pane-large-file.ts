export const LARGE_FILE_OPEN_WARNING_THRESHOLD_BYTES = 1024 * 1024;

export interface FileSizeLookupEntry {
  name: string;
  kind: "file" | "directory";
  size: number;
}

export interface FileSizeLookupClient {
  listDirectory(
    cwd: string,
    path: string,
  ): Promise<{
    entries: FileSizeLookupEntry[];
  }>;
}

export function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function shouldWarnBeforeOpeningFile(size: number): boolean {
  return size > LARGE_FILE_OPEN_WARNING_THRESHOLD_BYTES;
}

export function getFileNameFromFilePath(filePath: string): string {
  const normalized = trimTrailingSeparators(filePath.replace(/\\/g, "/"));
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function getParentDirectoryFromFilePath(filePath: string): string {
  const normalized = trimTrailingSeparators(filePath.replace(/\\/g, "/"));
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) {
    return ".";
  }
  if (slashIndex === 0) {
    return "/";
  }

  const parent = normalized.slice(0, slashIndex);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

export async function findFileSizeFromParentDirectory({
  client,
  cwd,
  path,
}: {
  client: FileSizeLookupClient;
  cwd: string;
  path: string;
}): Promise<number | null> {
  const fileName = getFileNameFromFilePath(path);
  if (!fileName) {
    return null;
  }

  const directory = await client.listDirectory(cwd, getParentDirectoryFromFilePath(path));
  const entry = directory.entries.find(
    (candidate) => candidate.kind === "file" && candidate.name === fileName,
  );
  return entry?.size ?? null;
}

function trimTrailingSeparators(value: string): string {
  if (value === "/" || /^[A-Za-z]:\/?$/.test(value)) {
    return value;
  }
  return value.replace(/\/+$/, "");
}
