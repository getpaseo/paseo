import { describe, expect, it } from "vitest";
import { resolveWorkspaceFileShareInput } from "@/screens/workspace/workspace-file-actions";

describe("resolveWorkspaceFileShareInput", () => {
  it("keeps workspace files scoped to the workspace", () => {
    expect(
      resolveWorkspaceFileShareInput({
        path: "docs/architecture.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      fileName: "architecture.md",
      path: "docs/architecture.md",
      root: "/Users/test/project",
    });
  });

  it("uses the filesystem root for an absolute file outside the workspace", () => {
    expect(
      resolveWorkspaceFileShareInput({
        path: "/tmp/architecture.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      fileName: "architecture.md",
      path: "/tmp/architecture.md",
      root: "/",
    });
  });

  it("uses the home root for a home-relative file", () => {
    expect(
      resolveWorkspaceFileShareInput({
        path: "~/.paseo/plans/architecture.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      fileName: "architecture.md",
      path: "~/.paseo/plans/architecture.md",
      root: "~",
    });
  });
});
