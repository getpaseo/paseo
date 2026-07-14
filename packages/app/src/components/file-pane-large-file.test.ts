import { describe, expect, it } from "vitest";
import {
  findFileSizeFromParentDirectory,
  getFileNameFromFilePath,
  getParentDirectoryFromFilePath,
  LARGE_FILE_OPEN_WARNING_THRESHOLD_BYTES,
  shouldWarnBeforeOpeningFile,
  type FileSizeLookupClient,
} from "@/components/file-pane-large-file";

describe("large file open warning helpers", () => {
  it("warns only when the file is over the threshold", () => {
    expect(shouldWarnBeforeOpeningFile(LARGE_FILE_OPEN_WARNING_THRESHOLD_BYTES)).toBe(false);
    expect(shouldWarnBeforeOpeningFile(LARGE_FILE_OPEN_WARNING_THRESHOLD_BYTES + 1)).toBe(true);
  });

  it.each([
    ["app.tsx", ".", "app.tsx"],
    ["src/app.tsx", "src", "app.tsx"],
    ["src/nested/app.tsx", "src/nested", "app.tsx"],
    ["/repo/src/app.tsx", "/repo/src", "app.tsx"],
    ["C:/repo/src/app.tsx", "C:/repo/src", "app.tsx"],
    ["C:/app.tsx", "C:/", "app.tsx"],
  ])("splits %s into parent and filename", (path, parent, fileName) => {
    expect(getParentDirectoryFromFilePath(path)).toBe(parent);
    expect(getFileNameFromFilePath(path)).toBe(fileName);
  });

  it("finds the target file size from its parent directory listing", async () => {
    const calls: Array<{ cwd: string; path: string }> = [];
    const client: FileSizeLookupClient = {
      async listDirectory(cwd, path) {
        calls.push({ cwd, path });
        return {
          entries: [
            { kind: "directory", name: "other", size: 0 },
            { kind: "file", name: "large.log", size: 2 * 1024 * 1024 },
          ],
        };
      },
    };

    await expect(
      findFileSizeFromParentDirectory({
        client,
        cwd: "/repo",
        path: "logs/large.log",
      }),
    ).resolves.toBe(2 * 1024 * 1024);
    expect(calls).toEqual([{ cwd: "/repo", path: "logs" }]);
  });
});
