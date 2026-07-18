import { clipboard } from "electron";
import { pathToFileURL } from "node:url";

export interface FilePathClipboard {
  writeBuffer(type: string, buffer: Buffer): void;
  writeText(text: string): void;
}

function buildMacFilenamesPlist(paths: readonly string[]): Buffer {
  const escaped = paths.map((filePath) =>
    filePath
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  );
  const entries = escaped.map((filePath) => `  <string>${filePath}</string>`).join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
${entries}
</array>
</plist>
`;
  return Buffer.from(plist, "utf8");
}

function buildWindowsDropFiles(paths: readonly string[]): Buffer {
  // CF_HDROP: DROPFILES header + double-null-terminated wide path list.
  const pathBlock = `${paths.join("\0")}\0\0`;
  const pathBytes = Buffer.from(pathBlock, "utf16le");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0); // pFiles offset
  header.writeUInt32LE(0, 4); // pt.x
  header.writeUInt32LE(0, 8); // pt.y
  header.writeUInt32LE(0, 12); // fNC
  header.writeUInt32LE(1, 16); // fWide
  return Buffer.concat([header, pathBytes]);
}

export function copyFilePathsToClipboard(
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
  fileClipboard: FilePathClipboard = clipboard,
): boolean {
  const normalized = paths.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return false;
  }

  if (platform === "darwin") {
    fileClipboard.writeBuffer("NSFilenamesPboardType", buildMacFilenamesPlist(normalized));
    return true;
  }

  if (platform === "win32") {
    fileClipboard.writeBuffer("CF_HDROP", buildWindowsDropFiles(normalized));
    return true;
  }

  const uriList = normalized.map((filePath) => pathToFileURL(filePath).href).join("\n");
  fileClipboard.writeBuffer("text/uri-list", Buffer.from(uriList, "utf8"));
  fileClipboard.writeText(normalized.join("\n"));
  return true;
}
