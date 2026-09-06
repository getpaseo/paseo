const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const DIFF_FILE_HEADER_HEIGHT = 30;
export const DIFF_FILE_HEADER_CONTENT_HEIGHT = 28;
export const DIFF_FILE_HEADER_LEFT = 12;
export const DIFF_FILE_HEADER_RIGHT = 8;
export const DIFF_FILE_HEADER_ICON_SIZE = 14;
export const DIFF_FILE_HEADER_TEXT_GAP = 4;

export function allocateDiffHeaderTextWidths(input: {
  available: number;
  nameWidth: number;
  directoryWidth: number;
}): { name: number; directory: number } {
  const available = Math.max(0, input.available);
  const nameWidth = Math.max(0, input.nameWidth);
  const directoryWidth = Math.max(0, input.directoryWidth);
  if (nameWidth >= available || directoryWidth === 0) {
    return { name: Math.min(nameWidth, available), directory: 0 };
  }
  const directoryAvailable = Math.max(0, available - nameWidth - DIFF_FILE_HEADER_TEXT_GAP);
  return { name: nameWidth, directory: Math.min(directoryWidth, directoryAvailable) };
}

export function formatDiffCount(value: number): string {
  return compactFormatter.format(value).toLowerCase();
}

export function fileNameForPath(path: string): string {
  return path.split("/").pop() ?? path;
}

export function directorySuffix(path: string): string {
  return path.includes("/") ? ` ${path.slice(0, path.lastIndexOf("/"))}` : "";
}

export function diffFileChangeKind(file: {
  isNew: boolean;
  isDeleted: boolean;
}): "added" | "deleted" | "modified" {
  if (file.isNew) return "added";
  if (file.isDeleted) return "deleted";
  return "modified";
}
