import { describe, expect, it } from "vitest";
import { resolveFilePreviewReadTarget } from "./preview-target";

describe("resolveFilePreviewReadTarget", () => {
  it("uses the workspace cwd for relative paths", () => {
    expect(
      resolveFilePreviewReadTarget({
        path: "packages/app/src/message.tsx",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "/Users/test/project",
      path: "packages/app/src/message.tsx",
    });
  });

  it("uses the workspace cwd for absolute paths inside the workspace", () => {
    expect(
      resolveFilePreviewReadTarget({
        path: "/Users/test/project/packages/app/src/message.tsx",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "/Users/test/project",
      path: "/Users/test/project/packages/app/src/message.tsx",
    });
  });

  it("uses the filesystem root for absolute paths outside the workspace", () => {
    expect(
      resolveFilePreviewReadTarget({
        path: "/tmp/paseo-preview.txt",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "/",
      path: "/tmp/paseo-preview.txt",
    });
  });

  it("uses the home root for tilde paths", () => {
    expect(
      resolveFilePreviewReadTarget({
        path: "~/.paseo/plans/file-preview.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "~",
      path: "~/.paseo/plans/file-preview.md",
    });
    expect(
      resolveFilePreviewReadTarget({
        path: "~/foo/../bar.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "~",
      path: "~/foo/../bar.md",
    });
  });

  it("uses a containing directory when a tilde path walks above home", () => {
    // `cwd: "~"` would resolve the file outside home and the daemon would refuse the read.
    expect(
      resolveFilePreviewReadTarget({
        path: "~/../other/plan.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "~/../other",
      path: "~/../other/plan.md",
    });
    expect(
      resolveFilePreviewReadTarget({
        path: "~/foo/../../other/plan.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "~/../other",
      path: "~/foo/../../other/plan.md",
    });
    expect(
      resolveFilePreviewReadTarget({
        path: "~/../plan.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      cwd: "~/..",
      path: "~/../plan.md",
    });
  });

  it("uses the drive root for Windows absolute paths outside the workspace", () => {
    expect(
      resolveFilePreviewReadTarget({
        path: "C:/Users/test/Desktop/file.txt",
        workspaceRoot: "D:/repo",
      }),
    ).toEqual({
      cwd: "C:/",
      path: "C:/Users/test/Desktop/file.txt",
    });
  });

  it("rejects relative paths without an absolute workspace root", () => {
    expect(resolveFilePreviewReadTarget({ path: "src/app.ts" })).toBeNull();
    expect(
      resolveFilePreviewReadTarget({
        path: "src/app.ts",
        workspaceRoot: "relative/root",
      }),
    ).toBeNull();
  });
});
