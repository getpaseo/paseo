import { describe, expect, it } from "vitest";
import { resolveCloneDirectoryName } from "./project-clone-directory.js";

describe("resolveCloneDirectoryName", () => {
  it("uses the repository name when no directory name is given", () => {
    expect(
      resolveCloneDirectoryName({ repositoryName: "devtools", directoryName: undefined }),
    ).toBe("devtools");
  });

  it("uses the trimmed directory name when one is given", () => {
    expect(
      resolveCloneDirectoryName({ repositoryName: "devtools", directoryName: " vite-devtools " }),
    ).toBe("vite-devtools");
  });

  it.each([
    ["", "Directory name cannot be empty"],
    ["   ", "Directory name cannot be empty"],
    [".", "Directory name cannot be . or .."],
    ["..", "Directory name cannot be . or .."],
    ["vite/devtools", "Directory name must be a single name without path separators"],
    ["vite\\devtools", "Directory name must be a single name without path separators"],
    ["vite\0devtools", "Directory name must be a single name without path separators"],
    ["C:devtools", "Directory name cannot be an absolute path"],
  ])("rejects %j", (directoryName, message) => {
    expect(() => resolveCloneDirectoryName({ repositoryName: "devtools", directoryName })).toThrow(
      message,
    );
  });
});
