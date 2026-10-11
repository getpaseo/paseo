import { describe, expect, it } from "vitest";
import { planInlinePathOpen } from "./inline-path-open";

describe("planInlinePathOpen", () => {
  it("opens paths with a line number directly as files", () => {
    expect(
      planInlinePathOpen({
        file: "src/moys-asr-workflow",
        lineStart: 12,
        workspaceRoot: "/repo",
      }),
    ).toEqual({ kind: "file" });
  });

  it("opens paths with a file extension directly as files", () => {
    expect(
      planInlinePathOpen({ file: "src/components/message.tsx", workspaceRoot: "/repo" }),
    ).toEqual({ kind: "file" });
    expect(planInlinePathOpen({ file: "README.md", workspaceRoot: "/repo" })).toEqual({
      kind: "file",
    });
  });

  it("treats a missing file segment as a directory", () => {
    expect(planInlinePathOpen({ file: undefined, workspaceRoot: "/repo" })).toEqual({
      kind: "directory",
      directoryPath: ".",
    });
  });

  it("probes extension-less workspace-relative paths against the workspace root", () => {
    expect(
      planInlinePathOpen({ file: "packages/app/moys-asr-workflow", workspaceRoot: "/repo" }),
    ).toEqual({
      kind: "probe",
      root: "/repo",
      relativePath: "packages/app/moys-asr-workflow",
      underWorkspace: true,
    });
    expect(planInlinePathOpen({ file: "Makefile", workspaceRoot: "/repo" })).toEqual({
      kind: "probe",
      root: "/repo",
      relativePath: "Makefile",
      underWorkspace: true,
    });
  });

  it("probes extension-less workspace folders case-insensitively on drive paths", () => {
    expect(
      planInlinePathOpen({ file: "C:/Repo/MOYS-ASR-WORKFLOW", workspaceRoot: "C:/repo" }),
    ).toEqual({
      kind: "probe",
      root: "C:/repo",
      relativePath: "MOYS-ASR-WORKFLOW",
      underWorkspace: true,
    });
  });

  it("probes extension-less absolute paths outside the workspace against their parent", () => {
    expect(
      planInlinePathOpen({
        file: "C:/Windows/System32/paseo-token-lease",
        workspaceRoot: "C:/repo",
      }),
    ).toEqual({
      kind: "probe",
      root: "C:/Windows/System32",
      relativePath: "paseo-token-lease",
      underWorkspace: false,
    });
  });

  it("opens extension-less paths directly as files when there is no workspace root", () => {
    expect(planInlinePathOpen({ file: "some-folder", workspaceRoot: "  " })).toEqual({
      kind: "file",
    });
  });
});
