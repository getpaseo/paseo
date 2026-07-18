import { describe, expect, it } from "vitest";
import { copyFilePathsToClipboard, type FilePathClipboard } from "./copy-paths.js";

function createRecordingClipboard(): FilePathClipboard & {
  buffers: Array<{ type: string; buffer: Buffer }>;
  texts: string[];
} {
  const buffers: Array<{ type: string; buffer: Buffer }> = [];
  const texts: string[] = [];
  return {
    buffers,
    texts,
    writeBuffer(type, buffer) {
      buffers.push({ type, buffer });
    },
    writeText(text) {
      texts.push(text);
    },
  };
}

describe("copyFilePathsToClipboard", () => {
  it("writes NSFilenamesPboardType on macOS", () => {
    const fileClipboard = createRecordingClipboard();
    expect(copyFilePathsToClipboard(["/tmp/a.txt", "/tmp/b"], "darwin", fileClipboard)).toBe(true);
    expect(fileClipboard.buffers).toHaveLength(1);
    expect(fileClipboard.buffers[0]?.type).toBe("NSFilenamesPboardType");
    const plist = fileClipboard.buffers[0]?.buffer.toString("utf8") ?? "";
    expect(plist).toContain("<string>/tmp/a.txt</string>");
    expect(plist).toContain("<string>/tmp/b</string>");
  });

  it("writes CF_HDROP on Windows", () => {
    const fileClipboard = createRecordingClipboard();
    expect(copyFilePathsToClipboard(["C:\\repo\\a.txt"], "win32", fileClipboard)).toBe(true);
    expect(fileClipboard.buffers[0]?.type).toBe("CF_HDROP");
  });

  it("writes uri-list and text on Linux", () => {
    const fileClipboard = createRecordingClipboard();
    expect(copyFilePathsToClipboard(["/tmp/a.txt"], "linux", fileClipboard)).toBe(true);
    expect(fileClipboard.buffers[0]?.type).toBe("text/uri-list");
    expect(fileClipboard.texts).toEqual(["/tmp/a.txt"]);
  });

  it("returns false for an empty path list", () => {
    const fileClipboard = createRecordingClipboard();
    expect(copyFilePathsToClipboard([], "darwin", fileClipboard)).toBe(false);
    expect(fileClipboard.buffers).toHaveLength(0);
  });
});
