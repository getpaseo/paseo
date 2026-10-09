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

  it("probes extension-less workspace-relative paths", () => {
    expect(
      planInlinePathOpen({ file: "packages/app/moys-asr-workflow", workspaceRoot: "/repo" }),
    ).toEqual({ kind: "probe", directoryPath: "packages/app/moys-asr-workflow" });
    expect(planInlinePathOpen({ file: "Makefile", workspaceRoot: "/repo" })).toEqual({
      kind: "probe",
      directoryPath: "Makefile",
    });
  });

  it("opens extension-less absolute paths directly as files", () => {
    expect(planInlinePathOpen({ file: "C:/Tools/some-folder", workspaceRoot: "C:/repo" })).toEqual({
      kind: "file",
    });
  });

  it("opens extension-less paths directly as files when there is no workspace root", () => {
    expect(planInlinePathOpen({ file: "some-folder", workspaceRoot: "  " })).toEqual({
      kind: "file",
    });
  });
});
