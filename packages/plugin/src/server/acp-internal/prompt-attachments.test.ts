import { describe, expect, it } from "vitest";
import { toAcpContentBlock } from "./prompt-attachments.js";

describe("toAcpContentBlock", () => {
  it("strips extra metadata from text attachments while preserving text and image blocks", () => {
    expect(
      toAcpContentBlock({
        type: "text",
        mimeType: "text/plain",
        contextKind: "external_resource",
        title: "Ticket",
        text: "Fix login timeout",
      }),
    ).toEqual({ type: "text", text: "Fix login timeout" });

    expect(toAcpContentBlock({ type: "image", data: "aGVsbG8=", mimeType: "image/png" })).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
  });

  it("renders forge change request, issue, review, and uploaded file attachments as readable text", () => {
    expect(
      toAcpContentBlock({
        type: "forge_change_request",
        mimeType: "application/paseo-forge-change-request",
        forge: "gitlab",
        number: 42,
        title: "Add streaming parser",
        url: "https://gitlab.example.com/group/repo/-/merge_requests/42",
        projectPath: "group/repo",
        baseRefName: "main",
        headRefName: "feat/parser",
        body: "Handles partial frames.",
      }),
    ).toEqual({
      type: "text",
      text: [
        "GitLab MR !42: Add streaming parser",
        "https://gitlab.example.com/group/repo/-/merge_requests/42",
        "Project: group/repo",
        "Base: main",
        "Head: feat/parser",
        "",
        "Handles partial frames.",
      ].join("\n"),
    });

    expect(
      toAcpContentBlock({
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 99,
        title: "Crash on startup",
        url: "https://github.com/org/repo/issues/99",
        body: "Steps to reproduce.",
      }),
    ).toEqual({
      type: "text",
      text: [
        "GitHub Issue #99: Crash on startup",
        "https://github.com/org/repo/issues/99",
        "",
        "Steps to reproduce.",
      ].join("\n"),
    });

    expect(
      toAcpContentBlock({
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/repo",
        mode: "base",
        baseRef: "main",
        comments: [
          {
            filePath: "src/app.ts",
            side: "new",
            lineNumber: 12,
            body: "Check null case",
            context: {
              hunkHeader: "@@ -10,2 +10,3 @@",
              targetLine: {
                oldLineNumber: null,
                newLineNumber: 12,
                type: "add",
                content: "return user.name;",
              },
              lines: [
                {
                  oldLineNumber: 11,
                  newLineNumber: 11,
                  type: "context",
                  content: "const user = get();",
                },
                {
                  oldLineNumber: null,
                  newLineNumber: 12,
                  type: "add",
                  content: "return user.name;",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      type: "text",
      text: [
        "Paseo review attachment (base)",
        "CWD: /repo",
        "Base: main",
        "",
        "Comment 1: src/app.ts:new:12",
        "Check null case",
        "@@ -10,2 +10,3 @@",
        "  11 11  const user = get();",
        ">  - 12 +return user.name;",
      ].join("\n"),
    });

    expect(
      toAcpContentBlock({
        type: "uploaded_file",
        id: "file-1",
        fileName: "trace.log",
        mimeType: "text/plain",
        size: 128,
        path: "/tmp/trace.log",
      }),
    ).toEqual({
      type: "text",
      text: [
        "Uploaded file: trace.log",
        "Path: /tmp/trace.log",
        "MIME: text/plain",
        "Size: 128 bytes",
      ].join("\n"),
    });
  });
});
