import { assert, describe, expect, it } from "vitest";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import {
  classifyAssistantFileLink,
  normalizeInlinePathTarget,
  parseAssistantFileLink,
  parseFileProtocolUrl,
  parseInlinePathToken,
} from "./parse";

describe("parseInlinePathToken", () => {
  it("returns null for plain paths without a line number", () => {
    expect(parseInlinePathToken("src/app.ts")).toBeNull();
    expect(parseInlinePathToken("README.md")).toBeNull();
  });

  it("parses filename:line", () => {
    expect(parseInlinePathToken("src/app.ts:12")).toEqual({
      raw: "src/app.ts:12",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("parses filename:lineStart-lineEnd", () => {
    expect(parseInlinePathToken("src/app.ts:12-20")).toEqual({
      raw: "src/app.ts:12-20",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("parses filename:line:column as a line target", () => {
    expect(parseInlinePathToken("src/app.ts:12:4")).toEqual({
      raw: "src/app.ts:12:4",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("parses filename(line,column) as a line target", () => {
    expect(parseInlinePathToken("src/app.ts(12,4)")).toEqual({
      raw: "src/app.ts(12,4)",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("parses filename lines lineStart-lineEnd", () => {
    expect(parseInlinePathToken("src/app.ts lines 12-20")).toEqual({
      raw: "src/app.ts lines 12-20",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("rejects range-only :line tokens", () => {
    expect(parseInlinePathToken(":12")).toBeNull();
    expect(parseInlinePathToken(":12-20")).toBeNull();
  });
});

describe("parseFileProtocolUrl", () => {
  it("parses file URLs with line fragments", () => {
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx#L81")).toEqual({
      raw: "file:///Users/test/project/src/app.tsx#L81",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 81,
      lineEnd: undefined,
    });
  });

  it("parses file URLs with line-column fragments", () => {
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx#L81C5-L83C2")).toEqual({
      raw: "file:///Users/test/project/src/app.tsx#L81C5-L83C2",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 81,
      lineEnd: 83,
    });
  });

  it("parses file URLs without line fragments", () => {
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx")).toEqual({
      raw: "file:///Users/test/project/src/app.tsx",
      path: "/Users/test/project/src/app.tsx",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("parses windows file URLs and line ranges", () => {
    expect(parseFileProtocolUrl("file:///C:/Users/test/project/src/app.tsx#L12-L20")).toEqual({
      raw: "file:///C:/Users/test/project/src/app.tsx#L12-L20",
      path: "C:/Users/test/project/src/app.tsx",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("rejects non-file URLs and invalid ranges", () => {
    expect(parseFileProtocolUrl("https://example.com/test.ts#L10")).toBeNull();
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx#L20-L12")).toBeNull();
  });
});

describe("classifyAssistantFileLink", () => {
  it("keeps explicit external URLs out of file parsing", () => {
    expect(
      classifyAssistantFileLink("http://dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "external",
      raw: "http://dumm.md",
    });
    expect(classifyAssistantFileLink("mailto:test@example.com")).toEqual({
      kind: "external",
      raw: "mailto:test@example.com",
    });
  });

  it("classifies bare workspace candidates separately from direct relative files", () => {
    expect(
      classifyAssistantFileLink("dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "ambiguousFileCandidate",
      target: {
        raw: "dumm.md",
        path: "/Users/test/project/dumm.md",
        lineStart: undefined,
        lineEnd: undefined,
      },
    });

    expect(
      classifyAssistantFileLink("message-renderer.tsx", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "ambiguousFileCandidate",
      target: {
        raw: "message-renderer.tsx",
        path: "/Users/test/project/message-renderer.tsx",
        lineStart: undefined,
        lineEnd: undefined,
      },
    });

    expect(
      classifyAssistantFileLink("src/components/message.tsx#L33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "directFile",
      target: {
        raw: "src/components/message.tsx#L33",
        path: "/Users/test/project/src/components/message.tsx",
        lineStart: 33,
        lineEnd: undefined,
      },
    });
  });

  it("does not classify normal bare domains as file candidates", () => {
    expect(
      classifyAssistantFileLink("google.com", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
    expect(
      classifyAssistantFileLink("example.com", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
    expect(
      classifyAssistantFileLink("openai.com/path", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("does not classify plain inline code words or identifiers as file candidates", () => {
    for (const value of [
      "main",
      "origin/main",
      "1f7fc232b",
      "25994904967",
      "babysit main 1f7fc232b",
    ]) {
      expect(
        classifyAssistantFileLink(value, {
          workspaceRoot: "/Users/test/project",
        }),
      ).toBeNull();
    }
  });

  it("does not classify shell commands containing path arguments as file candidates", () => {
    expect(
      classifyAssistantFileLink(
        "npm run lint -- packages/app/src/stores/workspace-layout-actions.ts packages/app/src/stores/workspace-layout-store.ts packages/app/src/screens/workspace/workspace-screen.tsx",
        {
          workspaceRoot: "/Users/test/project",
        },
      ),
    ).toBeNull();
  });
});

describe("parseAssistantFileLink", () => {
  it("resolves bare markdown filenames against the active workspace", () => {
    expect(
      parseAssistantFileLink("dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "dumm.md",
      path: "/Users/test/project/dumm.md",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("resolves bare source filenames with line suffixes against the active workspace", () => {
    expect(
      parseAssistantFileLink("file.ts:12", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "file.ts:12",
      path: "/Users/test/project/file.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("rejects bare domains and domain-like paths", () => {
    expect(
      parseAssistantFileLink("google.com", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
    expect(
      parseAssistantFileLink("google.com:80", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
    expect(
      parseAssistantFileLink("openai.com/path", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("resolves relative paths against the active workspace", () => {
    expect(
      parseAssistantFileLink("src/components/message.tsx#L33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "src/components/message.tsx#L33",
      path: "/Users/test/project/src/components/message.tsx",
      lineStart: 33,
      lineEnd: undefined,
    });
  });

  it("parses absolute POSIX hrefs inside the active workspace", () => {
    expect(
      parseAssistantFileLink("/Users/test/project/src/app.tsx#L33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "/Users/test/project/src/app.tsx#L33",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 33,
      lineEnd: undefined,
    });
  });

  it("parses absolute POSIX hrefs with VS Code-style line suffixes inside the active workspace", () => {
    expect(
      parseAssistantFileLink("/Users/test/project/src/app.tsx:33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "/Users/test/project/src/app.tsx:33",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 33,
      lineEnd: undefined,
    });
  });

  it("parses absolute Windows hrefs inside the active workspace", () => {
    expect(
      parseAssistantFileLink("C:/repo/src/app.tsx#L12-L20", {
        workspaceRoot: "C:/repo",
      }),
    ).toEqual({
      raw: "C:/repo/src/app.tsx#L12-L20",
      path: "C:/repo/src/app.tsx",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("parses absolute Windows hrefs with VS Code-style line suffixes inside the active workspace", () => {
    expect(
      parseAssistantFileLink("C:/repo/src/app.tsx:12-20", {
        workspaceRoot: "C:/repo",
      }),
    ).toEqual({
      raw: "C:/repo/src/app.tsx:12-20",
      path: "C:/repo/src/app.tsx",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("allows file URLs even when they are outside the workspace root", () => {
    expect(
      parseAssistantFileLink("file:///tmp/outside.txt", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "file:///tmp/outside.txt",
      path: "/tmp/outside.txt",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("allows absolute hrefs outside the workspace root", () => {
    expect(
      parseAssistantFileLink("/tmp/outside.txt", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "/tmp/outside.txt",
      path: "/tmp/outside.txt",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("keeps tilde hrefs as direct home-relative file targets", () => {
    expect(
      parseAssistantFileLink("~/.paseo/plans/file-preview.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "~/.paseo/plans/file-preview.md",
      path: "~/.paseo/plans/file-preview.md",
      lineStart: undefined,
      lineEnd: undefined,
    });
    expect(
      parseAssistantFileLink("~/.paseo/plans/file-preview.md:12", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "~/.paseo/plans/file-preview.md:12",
      path: "~/.paseo/plans/file-preview.md",
      lineStart: 12,
      lineEnd: undefined,
    });
    expect(
      parseAssistantFileLink("~\\.paseo\\plans\\file-preview.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "~\\.paseo\\plans\\file-preview.md",
      path: "~/.paseo/plans/file-preview.md",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("rejects external URLs", () => {
    expect(parseAssistantFileLink("https://example.com/Users/test/project/src/app.tsx")).toBeNull();
    expect(
      parseAssistantFileLink("http://dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("rejects invalid line fragments", () => {
    expect(
      parseAssistantFileLink("/Users/test/project/src/app.tsx#L20-L12", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("does not throw when the input contains a literal '%' that is not a valid percent-escape", () => {
    // Regressions for tool output strings like ping's "100% packet loss",
    // Windows "%PATH%" references, and percentages such as "0% off".
    // decodeURIComponent throws URIError on these; the parser must swallow
    // it and return null rather than crash the renderer.
    const cases = [
      "/tmp/100% packet loss",
      "/Users/test/project/0% off",
      "/var/log/%PATH%/x.log",
      "file:///tmp/100% packet loss",
    ];
    for (const value of cases) {
      expect(() =>
        parseAssistantFileLink(value, { workspaceRoot: "/Users/test/project" }),
      ).not.toThrow();
    }
    expect(() => parseFileProtocolUrl("file:///tmp/100% packet loss")).not.toThrow();
  });
});

describe("normalizeInlinePathTarget", () => {
  it("keeps a conversation's source file when the displayed checkout contains the same path", () => {
    const sourceRoot = "/checkouts/source";
    const destinationRoot = "/checkouts/displayed";
    const target = parseAssistantFileLink("src/app.ts#L12-L20", { workspaceRoot: sourceRoot });
    assert(target);
    const normalized = normalizeInlinePathTarget(target.path, {
      sourceCwd: sourceRoot,
      workspaceRoot: destinationRoot,
    });
    assert(normalized && "file" in normalized && normalized.file);
    expect(normalized.file).toBe("/checkouts/source/src/app.ts");
    expect(target).toMatchObject({ lineStart: 12, lineEnd: 20 });
    expect(
      resolveFilePreviewReadTarget({
        path: normalized.file,
        workspaceRoot: destinationRoot,
      }),
    ).toEqual({ cwd: "/", path: "/checkouts/source/src/app.ts" });
  });

  it("keeps relative file paths as file targets", () => {
    expect(
      normalizeInlinePathTarget("packages/app/src/components/message.tsx", {
        sourceCwd: "/Users/test/project",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      directory: "packages/app/src/components",
      file: "packages/app/src/components/message.tsx",
    });
  });

  it("resolves absolute paths under cwd back to workspace-relative paths", () => {
    expect(
      normalizeInlinePathTarget("/Users/test/project/packages/app/src/components/message.tsx", {
        sourceCwd: "/Users/test/project",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      directory: "packages/app/src/components",
      file: "packages/app/src/components/message.tsx",
    });
  });

  it("keeps absolute paths outside cwd as absolute file targets", () => {
    expect(
      normalizeInlinePathTarget("/tmp/message.tsx", {
        sourceCwd: "/Users/test/project",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      directory: "/tmp",
      file: "/tmp/message.tsx",
    });
  });

  it("keeps tilde paths as home-relative file targets", () => {
    expect(
      normalizeInlinePathTarget("~/.paseo/plans/file-preview.md", {
        sourceCwd: "/Users/test/project",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      directory: "~/.paseo/plans",
      file: "~/.paseo/plans/file-preview.md",
    });
  });

  it("treats cwd itself as the workspace root directory", () => {
    expect(
      normalizeInlinePathTarget("/Users/test/project", {
        sourceCwd: "/Users/test/project",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      directory: ".",
    });
  });

  it("keeps trailing-slash paths as directories", () => {
    expect(
      normalizeInlinePathTarget("/Users/test/project/packages/app/", {
        sourceCwd: "/Users/test/project",
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      directory: "packages/app",
    });
  });

  it("anchors relative tool paths to the conversation before handing them to another workspace", () => {
    expect(
      normalizeInlinePathTarget("src/app.ts", {
        sourceCwd: "/checkouts/source",
        workspaceRoot: "/checkouts/displayed",
      }),
    ).toEqual({ directory: "/checkouts/source/src", file: "/checkouts/source/src/app.ts" });
  });

  it.each([
    [
      "file:///checkouts/source/src/app.ts#L12",
      "/checkouts/source",
      "/checkouts/displayed",
      "/checkouts/source/src/app.ts",
    ],
    ["C:\\source\\src\\app.ts#L12", "C:/source", "C:/displayed", "C:/source/src/app.ts"],
    ["src/app.ts#L12", "/project/packages/app", "/project", "packages/app/src/app.ts"],
  ])("preserves file identity and line numbers from %s", (link, sourceCwd, workspaceRoot, file) => {
    const target = parseAssistantFileLink(link, { workspaceRoot: sourceCwd });
    assert(target);
    expect(target.lineStart).toBe(12);
    expect(normalizeInlinePathTarget(target.path, { sourceCwd, workspaceRoot })).toMatchObject({
      file,
    });
  });

  it.each([
    ["./", "/project", "."],
    ["src/", "/project/packages/app", "packages/app/src"],
    ["/project/packages/app/", "/other", "packages/app"],
  ])("keeps directory %s relative to the displayed workspace", (rawPath, sourceCwd, directory) => {
    expect(normalizeInlinePathTarget(rawPath, { sourceCwd, workspaceRoot: "/project" })).toEqual({
      directory,
    });
  });

  it.each([
    ["src/", "/other"],
    ["/other/", "/other"],
    ["/project-other/src/", "/project"],
    ["/project/../other/", "/project"],
    ["~/plans/", "/project"],
  ])("rejects directory %s before it can be used by the current Explorer", (rawPath, sourceCwd) => {
    expect(normalizeInlinePathTarget(rawPath, { sourceCwd, workspaceRoot: "/project" })).toEqual({
      error: "outsideWorkspaceDirectory",
    });
  });

  it("retains resolvable files when the displayed workspace is unavailable, but rejects directories", () => {
    expect(normalizeInlinePathTarget("src/app.ts", { sourceCwd: "/source" })).toEqual({
      directory: "/source/src",
      file: "/source/src/app.ts",
    });
    expect(normalizeInlinePathTarget("src/", { sourceCwd: "/source" })).toEqual({
      error: "outsideWorkspaceDirectory",
    });
    expect(normalizeInlinePathTarget("/source/src/app.ts", {})).toMatchObject({
      file: "/source/src/app.ts",
    });
  });

  it("refuses to anchor unresolved relative paths to the displayed checkout", () => {
    expect(normalizeInlinePathTarget("src/app.ts", { workspaceRoot: "/project" })).toBeNull();
    expect(
      normalizeInlinePathTarget("../app.ts", {
        sourceCwd: "/source",
        workspaceRoot: "/project",
      }),
    ).toBeNull();
  });
});
