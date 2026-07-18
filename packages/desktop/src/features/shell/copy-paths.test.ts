import { describe, expect, it, vi } from "vitest";

const writeBuffer = vi.fn();
const writeText = vi.fn();

vi.mock("electron", () => ({
  clipboard: {
    writeBuffer,
    writeText,
  },
}));

const { copyFilePathsToClipboard } = await import("./copy-paths.js");

describe("copyFilePathsToClipboard", () => {
  it("writes NSFilenamesPboardType on macOS", () => {
    writeBuffer.mockClear();
    expect(copyFilePathsToClipboard(["/tmp/a.txt", "/tmp/b"], "darwin")).toBe(true);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(writeBuffer.mock.calls[0]?.[0]).toBe("NSFilenamesPboardType");
    const plist = writeBuffer.mock.calls[0]?.[1].toString("utf8") as string;
    expect(plist).toContain("<string>/tmp/a.txt</string>");
    expect(plist).toContain("<string>/tmp/b</string>");
  });

  it("writes CF_HDROP on Windows", () => {
    writeBuffer.mockClear();
    expect(copyFilePathsToClipboard(["C:\\repo\\a.txt"], "win32")).toBe(true);
    expect(writeBuffer.mock.calls[0]?.[0]).toBe("CF_HDROP");
  });

  it("returns false for an empty path list", () => {
    expect(copyFilePathsToClipboard([], "darwin")).toBe(false);
  });
});
