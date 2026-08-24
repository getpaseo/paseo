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

  it("normalizes Windows separators before opening or presenting a file", () => {
    expect(describeWorkspaceFilePath("src\\components\\message.tsx")).toEqual({
      path: "src/components/message.tsx",
      name: "message.tsx",
      directory: "src/components",
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
