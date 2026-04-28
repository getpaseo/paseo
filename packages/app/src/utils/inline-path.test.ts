import { describe, expect, it } from "vitest";
import {
  normalizeInlinePathTarget,
  parseAssistantFileLink,
  parseFileProtocolUrl,
  parseInlinePathToken,
} from "./inline-path";

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

describe("parseAssistantFileLink", () => {
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

  it("rejects absolute hrefs outside the workspace root", () => {
    expect(
      parseAssistantFileLink("/tmp/outside.txt", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("rejects external URLs", () => {
    expect(parseAssistantFileLink("https://example.com/Users/test/project/src/app.tsx")).toBeNull();
  });

  it("rejects invalid line fragments", () => {
    expect(
      parseAssistantFileLink("/Users/test/project/src/app.tsx#L20-L12", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });
});

describe("normalizeInlinePathTarget", () => {
  it("keeps relative file paths as file targets", () => {
    expect(normalizeInlinePathTarget("packages/app/src/components/message.tsx")).toEqual({
      directory: "packages/app/src/components",
      file: "packages/app/src/components/message.tsx",
    });
  });

  it("resolves absolute paths under cwd back to workspace-relative paths", () => {
    expect(
      normalizeInlinePathTarget(
        "/Users/test/project/packages/app/src/components/message.tsx",
        "/Users/test/project",
      ),
    ).toEqual({
      directory: "packages/app/src/components",
      file: "packages/app/src/components/message.tsx",
    });
  });

  it("keeps absolute paths outside cwd as absolute file targets", () => {
    expect(normalizeInlinePathTarget("/tmp/message.tsx", "/Users/test/project")).toEqual({
      directory: "/tmp",
      file: "/tmp/message.tsx",
    });
  });

  it("treats cwd itself as the workspace root directory", () => {
    expect(normalizeInlinePathTarget("/Users/test/project", "/Users/test/project")).toEqual({
      directory: ".",
    });
  });

  it("keeps trailing-slash paths as directories", () => {
    expect(
      normalizeInlinePathTarget("/Users/test/project/packages/app/", "/Users/test/project"),
    ).toEqual({
      directory: "packages/app",
    });
  });
});
