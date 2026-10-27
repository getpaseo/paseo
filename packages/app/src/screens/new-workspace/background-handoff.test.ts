import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { captureWorkspaceDraftCleanup } from "./background-handoff";

const DRAFT_ID = "draft_1";
const DRAFT_KEY = "new-workspace";
const SCOPE_KEY = "draft:draft_1";

function saveDraft(text: string) {
  useDraftStore
    .getState()
    .saveDraftInput({ draftKey: DRAFT_KEY, draft: { text, attachments: [] } });
}

function draftText(): string | undefined {
  return useDraftStore.getState().drafts[DRAFT_KEY]?.input.text;
}

function captureCleanup() {
  return captureWorkspaceDraftCleanup({
    draftId: DRAFT_ID,
    draftKey: DRAFT_KEY,
    clearDraft: (lifecycle) =>
      useDraftStore.getState().clearDraftInput({ draftKey: DRAFT_KEY, lifecycle }),
    draftContextScopeKey: SCOPE_KEY,
  });
}

function setSetup(cwd: string) {
  useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
    draftId: DRAFT_ID,
    setup: {
      cwd,
      provider: "codex",
      modeId: null,
      model: null,
      thinkingOptionId: null,
      featureValues: {},
    },
  });
}

function addContext() {
  useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
    scopeKey: SCOPE_KEY,
    attachment: {
      kind: "chat_history",
      id: "fork-context",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Chat history",
        text: "Preserve this context",
      },
      source: { serverId: "local", agentId: "agent-1" },
    },
  });
}

beforeEach(() => {
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, setupByDraftId: {} });
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: { [SCOPE_KEY]: [] } });
  saveDraft("do the thing");
});

describe("captureWorkspaceDraftCleanup", () => {
  it("clears the consumed draft setup, attachments and input", () => {
    setSetup("/work/repo");
    addContext();
    const clearConsumedDraft = captureCleanup();

    clearConsumedDraft();

    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).toEqual({});
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toBeUndefined();
    expect(draftText()).toBe("");
  });

  it("preserves newer setup without requiring a text edit", () => {
    setSetup("/work/repo");
    const clearConsumedDraft = captureCleanup();
    setSetup("/work/new-repo");

    clearConsumedDraft();

    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId[DRAFT_ID]?.setup.cwd).toBe(
      "/work/new-repo",
    );
    expect(draftText()).toBe("do the thing");
  });

  it("preserves context changed while workspace creation was pending", () => {
    const clearConsumedDraft = captureCleanup();
    addContext();

    clearConsumedDraft();

    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toHaveLength(1);
    expect(draftText()).toBe("do the thing");
  });

  it("keeps a prompt typed into the shared draft while creation was in flight", () => {
    const clearConsumedDraft = captureCleanup();
    saveDraft("a different idea");

    clearConsumedDraft();

    expect(draftText()).toBe("a different idea");
  });

  it("keeps unchanged context when a newer draft owns it", () => {
    addContext();
    const clearConsumedDraft = captureCleanup();
    saveDraft("a newer workspace idea");

    clearConsumedDraft();

    expect(draftText()).toBe("a newer workspace idea");
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toHaveLength(1);
  });
});
