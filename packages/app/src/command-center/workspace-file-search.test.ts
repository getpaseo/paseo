import { describe, expect, it } from "vitest";
import { describeWorkspaceFilePath } from "./workspace-file-search-model";

describe("describeWorkspaceFilePath", () => {
  it("separates a workspace-relative file into its row labels", () => {
    expect(describeWorkspaceFilePath("src/components/message.tsx")).toEqual({
      path: "src/components/message.tsx",
      name: "message.tsx",
      directory: "src/components",
    });
  });

  it("treats a backslash as part of the file name, because the host already sent separators as /", () => {
    expect(describeWorkspaceFilePath("a\\b.txt")).toEqual({
      path: "a\\b.txt",
      name: "a\\b.txt",
      directory: "",
    });
  });

  it("keeps root files free of a redundant directory label", () => {
    expect(describeWorkspaceFilePath("package.json")).toEqual({
      path: "package.json",
      name: "package.json",
      directory: "",
    });
  });
});
