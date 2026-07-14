import { describe, expect, it } from "vitest";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { migratePersistedState, type MigrateLegacyImages } from "./migration";
import { isAttachmentMetadata, type DraftRecord } from "./state";

const passThroughMigrateLegacyImages: MigrateLegacyImages = async (images) =>
  images.filter(isAttachmentMetadata);

function activeDraft(
  text: string,
  updatedAt: number,
  attachments: UserComposerAttachment[] = [],
): DraftRecord {
  return {
    input: { text, attachments },
    lifecycle: "active",
    updatedAt,
    version: 1,
  };
}

function githubIssueAttachment(
  number: number,
): Extract<UserComposerAttachment, { kind: "github_issue" }> {
  return {
    kind: "github_issue",
    item: {
      kind: "issue",
      number,
      title: `Review item ${number}`,
      url: `https://example.com/issues/${number}`,
      state: "open",
      body: null,
      labels: [],
    },
  };
}

function githubPrAttachment(
  number: number,
): Extract<UserComposerAttachment, { kind: "github_pr" }> {
  return {
    kind: "github_pr",
    item: {
      kind: "pr",
      number,
      title: `Review item ${number}`,
      url: `https://example.com/pulls/${number}`,
      state: "open",
      body: null,
      labels: [],
      baseRefName: "main",
      headRefName: "feature/legacy",
    },
  };
}

function workspaceReviewAttachment(): Extract<ComposerAttachment, { kind: "review" }> {
  return {
    kind: "review",
    reviewDraftKey: "review:key",
    commentCount: 1,
    attachment: {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/repo",
      mode: "uncommitted",
      baseRef: null,
      comments: [
        {
          filePath: "src/example.ts",
          side: "new",
          lineNumber: 41,
          body: "Please simplify this.",
          context: {
            hunkHeader: "@@ -40,1 +40,1 @@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 41,
              type: "add",
              content: "const value = newValue;",
            },
            lines: [
              {
                oldLineNumber: null,
                newLineNumber: 41,
                type: "add",
                content: "const value = newValue;",
              },
            ],
          },
        },
      ],
    },
  };
}

describe("draft-store migration", () => {
  it("promotes the newest legacy New Workspace draft into the singleton surface", async () => {
    const forkDraft = activeDraft("fork context", 1700000000003);
    const agentDraft = activeDraft("agent prompt", 1700000000004);

    const migrated = await migratePersistedState(
      {
        drafts: {
          "new-workspace:server-a:/project/older": activeDraft(
            "older new workspace prompt",
            1700000000001,
          ),
          "new-workspace:server-b:/project/newer": activeDraft(
            "newer new workspace prompt",
            1700000000002,
          ),
          "new-workspace:draft:fork-1": forkDraft,
          "agent:server-a:agent-1": agentDraft,
        },
        createModalDraft: null,
      },
      { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 1700000000005 },
    );

    expect(migrated.drafts).toEqual({
      "new-workspace": activeDraft("newer new workspace prompt", 1700000000002),
      "new-workspace:draft:fork-1": forkDraft,
      "agent:server-a:agent-1": agentDraft,
    });
  });

  it("drops unowned checkout PR context when promoting a scoped New Workspace draft", async () => {
    const issue = githubIssueAttachment(101);
    const migrated = await migratePersistedState(
      {
        drafts: {
          "new-workspace:server-a:/project/a": activeDraft("keep the prompt", 2, [
            issue,
            githubPrAttachment(202),
          ]),
        },
        createModalDraft: null,
      },
      { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 3 },
    );

    expect(migrated.drafts["new-workspace"]?.input).toEqual({
      text: "keep the prompt",
      attachments: [issue],
    });
  });

  it("normalizes legacy image metadata into image attachments and strips persisted preview URLs", async () => {
    const migrated = await migratePersistedState(
      {
        drafts: {
          "agent:server:agent": {
            input: {
              text: "hello",
              images: [
                {
                  id: "att-1",
                  mimeType: "image/png",
                  storageType: "desktop-file",
                  storageKey: "/tmp/att-1.png",
                  createdAt: 1700000000000,
                  previewUri: "asset://should-not-persist",
                },
              ],
            },
            lifecycle: "active",
            updatedAt: 1700000000001,
            version: 1,
          },
        },
        createModalDraft: null,
      },
      { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 1700000000002 },
    );

    expect(migrated.drafts["agent:server:agent"]?.input).toEqual({
      text: "hello",
      attachments: [
        {
          kind: "image",
          metadata: {
            id: "att-1",
            mimeType: "image/png",
            storageType: "desktop-file",
            storageKey: "/tmp/att-1.png",
            createdAt: 1700000000000,
          },
        },
      ],
    });
  });

  it("hydrates old persisted drafts that still include cwd", async () => {
    const original = {
      drafts: {
        "agent:server:agent": {
          input: {
            text: "hello",
            attachments: [
              {
                kind: "image",
                metadata: {
                  id: "att-1",
                  mimeType: "image/jpeg",
                  storageType: "web-indexeddb",
                  storageKey: "att-1",
                  createdAt: 1700000000000,
                },
              },
            ],
            cwd: "/repo",
          },
          lifecycle: "active",
          updatedAt: 1700000000001,
          version: 2,
        },
      },
      createModalDraft: null,
    };

    const ports = { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 1700000000002 };
    const once = await migratePersistedState(original, ports);
    const twice = await migratePersistedState(once, ports);

    expect(twice).toEqual(once);
    expect(twice.drafts["agent:server:agent"]?.input).toEqual({
      text: "hello",
      attachments: [
        {
          kind: "image",
          metadata: {
            id: "att-1",
            mimeType: "image/jpeg",
            storageType: "web-indexeddb",
            storageKey: "att-1",
            createdAt: 1700000000000,
          },
        },
      ],
    });
  });

  it("rejects workspace review attachments from migrated draft attachments", async () => {
    const migrated = await migratePersistedState(
      {
        drafts: {
          "agent:server:agent": {
            input: {
              text: "hello",
              attachments: [workspaceReviewAttachment()],
            },
            lifecycle: "active",
            updatedAt: 1700000000001,
            version: 2,
          },
        },
        createModalDraft: null,
      },
      { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 1700000000002 },
    );

    expect(migrated.drafts["agent:server:agent"]?.input.attachments).toEqual([]);
  });
});
