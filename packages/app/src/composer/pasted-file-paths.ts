import type { DesktopHostBridge } from "@/desktop/host";

/**
 * Pasting files copied in Finder (or another file manager) inserts their absolute paths, as a
 * terminal does. A Finder copy carries only the item names as plain text ("phd"), so without this
 * the composer receives a bare name the agent cannot resolve.
 */

type ClipboardLike = Pick<DataTransfer, "getData"> & {
  items?: DataTransferItemList | ArrayLike<DataTransferItem> | null;
};

/** One path per paste item; paths with whitespace are quoted so the agent reads them whole. */
export function formatPastedPaths(paths: readonly string[]): string {
  return paths.map((path) => (/\s/.test(path) ? `"${path}"` : path)).join(" ");
}

function baseName(path: string): string {
  return path.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? path;
}

/** Paths the renderer can resolve itself, for file items the browser exposes on paste. */
export function pastedFilePathsFromItems(
  clipboard: ClipboardLike | null | undefined,
  getPathForFile: ((file: File) => string) | undefined,
): string[] {
  if (!clipboard?.items || typeof getPathForFile !== "function") return [];
  const paths: string[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item?.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (!file) continue;
    try {
      const path = getPathForFile(file);
      if (typeof path === "string" && path.startsWith("/")) paths.push(path);
    } catch {
      // A file that exists only as bytes has no path.
    }
  }
  return paths;
}

/**
 * Whether plain text looks like the names Finder puts on the clipboard: one or more short lines
 * without a slash. Ordinary prose, code and paths do not trigger the desktop lookup.
 */
export function looksLikeCopiedFileNames(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > 100) return false;
  return lines.every((line) => line.length <= 255 && !line.includes("/") && line.trim() === line);
}

/** The desktop paths replace the text only when they are the items the text names. */
export function pathsMatchCopiedNames(paths: readonly string[], text: string): boolean {
  if (paths.length === 0) return false;
  const names = new Set(text.split(/\r\n|\r|\n/).filter((line) => line.length > 0));
  return paths.every((path) => names.has(baseName(path)));
}

function insertText(input: HTMLElement, text: string): void {
  input.focus();
  // Same undoable editing command the linked-text paste uses; it emits the normal input event.
  input.ownerDocument.execCommand("insertText", false, text);
}

/**
 * Handles a paste of copied files. Returns true when it took over the paste (the caller then
 * prevents the default text paste). The desktop lookup is asynchronous: the original text is
 * inserted instead when the clipboard turns out to hold no matching files.
 */
export function pasteCopiedFilePaths(
  input: HTMLElement,
  clipboard: ClipboardLike | null | undefined,
  host: DesktopHostBridge | null,
  isDisposed: () => boolean = () => false,
): boolean {
  const direct = pastedFilePathsFromItems(clipboard, host?.webUtils?.getPathForFile);
  if (direct.length > 0) {
    insertText(input, formatPastedPaths(direct));
    return true;
  }
  const readFilePaths = host?.clipboard?.readFilePaths;
  const text = clipboard?.getData("text/plain") ?? "";
  if (typeof readFilePaths !== "function" || !looksLikeCopiedFileNames(text)) return false;
  void readFilePaths()
    .then((paths) => (pathsMatchCopiedNames(paths, text) ? formatPastedPaths(paths) : text))
    .catch(() => text)
    .then((replacement) => {
      if (!isDisposed()) insertText(input, replacement);
      return;
    });
  return true;
}
