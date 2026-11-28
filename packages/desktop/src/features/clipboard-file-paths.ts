import { fileURLToPath } from "node:url";

/** The part of an Electron ClipboardItem this reads; injectable for tests. */
export interface ClipboardItemLike {
  readonly types: readonly string[];
  getType(type: string): Promise<unknown>;
}

/** The part of Electron's clipboard this reads (Electron 44 async API). */
export interface ClipboardFileSource {
  read(): Promise<readonly ClipboardItemLike[]>;
}

/** Finder's list of every copied item, exposed through Electron's raw OS format. */
export const FILENAMES_TYPE = 'electron application/osclipboard;format="NSFilenamesPboardType"';
const URI_LIST_TYPE = "text/uri-list";
const READ_TIMEOUT_MS = 2000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("clipboard read timed out")), ms),
    ),
  ]);
}

async function readText(item: ClipboardItemLike, type: string): Promise<string> {
  const value = await within(item.getType(type), READ_TIMEOUT_MS);
  if (typeof value === "string") return value;
  if (value && typeof (value as Blob).text === "function") return (value as Blob).text();
  return "";
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Paths from the XML property list Finder writes as NSFilenamesPboardType. */
export function parseFilenamesPlist(xml: string): string[] {
  const paths: string[] = [];
  for (const match of xml.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    const path = unescapeXml(match[1] ?? "").trim();
    if (path.startsWith("/")) paths.push(path);
  }
  return paths;
}

/** Local paths from a text/uri-list (one URI per line, `#` lines are comments). */
export function parseUriList(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const uri = line.trim();
    if (!uri.startsWith("file://")) continue;
    try {
      paths.push(fileURLToPath(uri));
    } catch {
      // Not a local file URI.
    }
  }
  return paths;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, "") : path;
}

/**
 * Absolute paths of the files and folders copied in Finder (or another file manager). A Finder
 * copy carries only the item names as plain text, so a text paste yields "phd" where a terminal
 * pastes the full path. Prefers Finder's list of every copied item, then the URI list.
 */
export async function readClipboardFilePaths(source: ClipboardFileSource): Promise<string[]> {
  let items: readonly ClipboardItemLike[];
  try {
    items = await within(source.read(), READ_TIMEOUT_MS);
  } catch {
    return [];
  }
  const collect = async (type: string, parse: (text: string) => string[]) => {
    const paths: string[] = [];
    for (const item of items) {
      if (!item.types.includes(type)) continue;
      try {
        paths.push(...parse(await readText(item, type)));
      } catch {
        // Unreadable format; try the next one.
      }
    }
    return paths;
  };
  let paths = await collect(FILENAMES_TYPE, parseFilenamesPlist);
  if (paths.length === 0) paths = await collect(URI_LIST_TYPE, parseUriList);
  return [...new Set(paths.map(withoutTrailingSlash))];
}
