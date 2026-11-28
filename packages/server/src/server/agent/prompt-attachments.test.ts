import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentBranchNameSeed,
  buildAgentPrompt,
  renderPromptAttachmentAsText,
  resolveAgentPrompt,
} from "./prompt-attachments.js";

describe("prompt attachments", () => {
  it("places fork history before the new user prompt", () => {
    const chatHistory = {
      type: "text" as const,
      mimeType: "text/plain",
      contextKind: "chat_history" as const,
      title: "Chat history",
      text: "<chat-history-summary>\nPrevious work\n</chat-history-summary>",
    };
    const issue = {
      type: "github_issue" as const,
      mimeType: "application/github-issue",
      number: 55,
      title: "Issue",
      url: "https://github.com/getpaseo/paseo/issues/55",
    };

    expect(
      buildAgentPrompt(
        "  Take a different approach  ",
        [{ data: "image-data", mimeType: "image/png" }],
        [issue, chatHistory],
      ),
    ).toEqual([
      chatHistory,
      { type: "text", text: "Take a different approach" },
      { type: "image", data: "image-data", mimeType: "image/png" },
      issue,
    ]);
  });

  it("renders github_pr attachments as readable text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://github.com/getpaseo/paseo/pull/123",
        body: "PR body",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      }),
    ).toContain("GitHub PR #123: Fix race in worktree setup");
  });

  it("renders GitLab change request attachments with MR numbering", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "forge_change_request",
        mimeType: "application/paseo-forge-change-request",
        forge: "gitlab",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://gitlab.com/getpaseo/paseo/-/merge_requests/123",
        body: "MR body",
        projectPath: "getpaseo/paseo",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      }),
    ).toContain("GitLab MR !123: Fix race in worktree setup");
  });

  it.each(["base", "uncommitted", "all"] as const)("renders %s reviews", (mode) => {
    expect(
      renderPromptAttachmentAsText({
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/tmp/repo",
        mode,
        baseRef: "main",
        comments: [
          {
            filePath: "src/index.ts",
            side: "new",
            lineNumber: 42,
            body: "Please guard this nullable value.",
            context: {
              hunkHeader: "@@ -40,3 +40,4 @@",
              targetLine: {
                oldLineNumber: null,
                newLineNumber: 42,
                type: "add",
                content: "const value = maybeNull.name;",
              },
              lines: [
                {
                  oldLineNumber: 41,
                  newLineNumber: 41,
                  type: "context",
                  content: "const before = true;",
                },
                {
                  oldLineNumber: null,
                  newLineNumber: 42,
                  type: "add",
                  content: "const value = maybeNull.name;",
                },
              ],
            },
          },
        ],
      }),
    ).toBe(
      [
        `Paseo review attachment (${mode})`,
        "CWD: /tmp/repo",
        "Base: main",
        "",
        "Comment 1: src/index.ts:new:42",
        "Please guard this nullable value.",
        "@@ -40,3 +40,4 @@",
        "  41 41  const before = true;",
        ">  - 42 +const value = maybeNull.name;",
      ].join("\n"),
    );
  });

  it("renders github_issue attachments as readable text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 55,
        title: "Issue",
        url: "https://github.com/getpaseo/paseo/issues/55",
      }),
    ).toContain("GitHub Issue #55: Issue");
  });

  it("renders text attachments as their client-provided prompt text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "text",
        mimeType: "text/plain",
        title: "Browser element",
        text: "<browser-element>button.primary</browser-element>",
      }),
    ).toBe("<browser-element>button.primary</browser-element>");
  });

  it("renders uploaded file attachments as local file references", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "uploaded_file",
        id: "upload_req-upload",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 11,
        path: "/tmp/paseo/uploads/upload_req-upload/notes.txt",
      }),
    ).toBe(
      [
        "Uploaded file: notes.txt",
        "Path: /tmp/paseo/uploads/upload_req-upload/notes.txt",
        "MIME: text/plain",
        "Size: 11 bytes",
      ].join("\n"),
    );
  });

  it("returns undefined when firstAgentContext is empty", () => {
    expect(buildAgentBranchNameSeed(undefined)).toBeUndefined();
    expect(buildAgentBranchNameSeed({})).toBeUndefined();
    expect(buildAgentBranchNameSeed({ prompt: "   " })).toBeUndefined();
    expect(buildAgentBranchNameSeed({ attachments: [] })).toBeUndefined();
  });

  it("wraps prompt and rendered attachments as tagged naming input", () => {
    expect(
      buildAgentBranchNameSeed({
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Fix worktree naming",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "fix/worktree-naming",
          },
        ],
      }),
    ).toBe(
      "<user-prompt>\nInvestigate flaky test\n</user-prompt>\n\n<attachments>\nGitHub PR #123: Fix worktree naming\nhttps://github.com/getpaseo/paseo/pull/123\nBase: main\nHead: fix/worktree-naming\n</attachments>",
    );
  });
});

describe("resolveAgentPrompt uploaded images", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeHome() {
    const home = await realpath(await mkdtemp(join(tmpdir(), "paseo-prompt-img-")));
    tempDirs.push(home);
    await mkdir(join(home, "uploads", "upload_1"), { recursive: true });
    return home;
  }

  it("resolves uploaded_file attachments with role='image' inside paseoHome/uploads into native image prompt blocks while keeping plain uploaded_file attachments intact", async () => {
    const home = await makeHome();
    const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const imagePath = join(home, "uploads", "upload_1", "photo.png");
    await writeFile(imagePath, rawBytes);
    const plainFileAttachment = {
      type: "uploaded_file" as const,
      id: "upload_plain",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      size: 512,
      path: join(home, "uploads", "upload_plain", "report.pdf"),
    };

    const prompt = await resolveAgentPrompt({
      paseoHome: home,
      text: "What is in this image?",
      attachments: [
        plainFileAttachment,
        {
          type: "uploaded_file",
          id: "upload_1",
          fileName: "photo.png",
          mimeType: "image/png",
          size: rawBytes.byteLength,
          path: imagePath,
          role: "image",
        },
      ],
    });

    expect(prompt).toEqual([
      { type: "text", text: "What is in this image?" },
      {
        type: "image",
        data: rawBytes.toString("base64"),
        mimeType: "image/png",
        uploadedImage: {
          id: "upload_1",
          fileName: "photo.png",
          mimeType: "image/png",
          size: rawBytes.byteLength,
          path: imagePath,
        },
      },
      plainFileAttachment,
    ]);
  });

  it("supports image-only prompts with empty text", async () => {
    const home = await makeHome();
    const rawBytes = Buffer.from("jpeg-bytes");
    const imagePath = join(home, "uploads", "upload_1", "only.jpg");
    await writeFile(imagePath, rawBytes);

    const prompt = await resolveAgentPrompt({
      paseoHome: home,
      text: "   ",
      attachments: [
        {
          type: "uploaded_file",
          id: "upload_1",
          fileName: "only.jpg",
          mimeType: "image/jpeg",
          size: rawBytes.byteLength,
          path: imagePath,
          role: "image",
        },
      ],
    });

    expect(prompt).toEqual([
      {
        type: "image",
        data: rawBytes.toString("base64"),
        mimeType: "image/jpeg",
        uploadedImage: {
          id: "upload_1",
          fileName: "only.jpg",
          mimeType: "image/jpeg",
          size: rawBytes.byteLength,
          path: imagePath,
        },
      },
    ]);
  });

  it("rejects path traversal, outside paths, prefix-collision paths, symlinks escaping uploads/, and directories", async () => {
    const home = await makeHome();
    const secretPath = join(home, "local-credential");
    await writeFile(secretPath, "super-secret-token");

    const siblingDir = join(home, "uploads-evil");
    await mkdir(siblingDir, { recursive: true });
    const siblingPath = join(siblingDir, "leak.png");
    await writeFile(siblingPath, "evil");

    const symlinkPath = join(home, "uploads", "upload_1", "escape.png");
    await symlink(secretPath, symlinkPath);

    const baseImage = {
      type: "uploaded_file" as const,
      id: "upload_1",
      fileName: "bad.png",
      mimeType: "image/png",
      size: 16,
      role: "image" as const,
    };

    // 1. ../ traversal out of uploads/
    await expect(
      resolveAgentPrompt({
        paseoHome: home,
        text: "leak",
        attachments: [{ ...baseImage, path: join(home, "uploads", "..", "local-credential") }],
      }),
    ).rejects.toThrow(/outside/i);

    // 2. Direct path outside uploads/
    await expect(
      resolveAgentPrompt({
        paseoHome: home,
        text: "leak",
        attachments: [{ ...baseImage, path: secretPath }],
      }),
    ).rejects.toThrow(/outside/i);

    // 3. Sibling prefix-collision directory (uploads-evil)
    await expect(
      resolveAgentPrompt({
        paseoHome: home,
        text: "leak",
        attachments: [{ ...baseImage, path: siblingPath }],
      }),
    ).rejects.toThrow(/outside/i);

    // 4. Symlink inside uploads/ pointing outside uploads/
    await expect(
      resolveAgentPrompt({
        paseoHome: home,
        text: "leak",
        attachments: [{ ...baseImage, path: symlinkPath }],
      }),
    ).rejects.toThrow(/outside/i);

    // 5. Directory instead of file
    await expect(
      resolveAgentPrompt({
        paseoHome: home,
        text: "dir",
        attachments: [{ ...baseImage, path: join(home, "uploads", "upload_1") }],
      }),
    ).rejects.toThrow(/not a file|regular file/i);
  });
});
