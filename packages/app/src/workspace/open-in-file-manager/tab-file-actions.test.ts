import { describe, expect, it } from "vitest";
import { parentDirectory } from "@/workspace/open-in-file-manager/tab-file-actions";

describe("parentDirectory", () => {
  it("returns the containing directory for posix paths", () => {
    expect(parentDirectory("/w/project/src/REPORT.md")).toBe("/w/project/src");
    expect(parentDirectory("/REPORT.md")).toBe("/");
  });

  it("keeps the slash on a Windows drive root", () => {
    // `C:` alone is not a directory, so a file directly under the drive root
    // must resolve to `C:/` (Finder/Explorer refuses to reveal through `C:`).
    expect(parentDirectory("C:/REPORT.md")).toBe("C:/");
    expect(parentDirectory("C:/project/REPORT.md")).toBe("C:/project");
  });

  it("falls back to the input when there is no separator", () => {
    expect(parentDirectory("REPORT.md")).toBe("REPORT.md");
  });
});
