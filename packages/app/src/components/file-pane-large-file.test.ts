import { describe, expect, it } from "vitest";
import {
  findFileSizeFromParentDirectory,
  getFileNameFromFilePath,
  shouldWarnBeforeOpeningFile,
  type FileSizeLookupClient,
} from "@/components/file-pane-large-file";

describe("large file open warning helpers", () => {
  it("warns only when the file is over the threshold", () => {
    const thresholdBytes = 5 * 1024 * 1024;
    expect(shouldWarnBeforeOpeningFile(thresholdBytes, thresholdBytes)).toBe(false);
    expect(shouldWarnBeforeOpeningFile(thresholdBytes + 1, thresholdBytes)).toBe(true);
  });

  it.each([
    ["app.tsx", "app.tsx"],
    ["src/app.tsx", "app.tsx"],
    ["src/nested/app.tsx", "app.tsx"],
    ["/repo/src/app.tsx", "app.tsx"],
    ["C:/repo/src/app.tsx", "app.tsx"],
    ["C:/app.tsx", "app.tsx"],
  ])("extracts the filename from %s", (path, fileName) => {
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
            { kind: "file", name: "app.tsx", size: 2 * 1024 * 1024 },
          ],
        };
      },
    };

    await expect(
      findFileSizeFromParentDirectory({
        client,
        cwd: "/repo",
        path: "C:/app.tsx",
      }),
    ).resolves.toBe(2 * 1024 * 1024);
    expect(calls).toEqual([{ cwd: "/repo", path: "C:/" }]);
  });

  it("finds the target file size when path casing differs from the directory entry", async () => {
    const client: FileSizeLookupClient = {
      async listDirectory() {
        return {
          entries: [{ kind: "file", name: "Large.txt", size: 6 * 1024 * 1024 }],
        };
      },
    };

    await expect(
      findFileSizeFromParentDirectory({ client, cwd: "/repo", path: "large.txt" }),
    ).resolves.toBe(6 * 1024 * 1024);
  });
});
