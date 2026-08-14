import { beforeEach, describe, expect, it } from "vitest";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { createWorkspaceAgentInBackground } from "./background-handoff";

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

function run(createAgent: () => Promise<unknown>) {
  return createWorkspaceAgentInBackground({
    draftId: DRAFT_ID,
    draftKey: DRAFT_KEY,
    draftContextScopeKey: SCOPE_KEY,
    createAgent,
  });
}

beforeEach(() => {
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, setupByDraftId: {} });
  useCreateFlowStore.setState({ pendingByDraftId: {} });
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: { [SCOPE_KEY]: [] } });
  saveDraft("do the thing");
});

describe("createWorkspaceAgentInBackground", () => {
  it("creates one agent and clears the consumed draft setup, attachments and input", async () => {
    let calls = 0;
    useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
      draftId: DRAFT_ID,
      setup: {
        cwd: "/work/repo",
        provider: "claude",
        modeId: null,
        model: null,
        thinkingOptionId: null,
        featureValues: {},
      },
    });

    await run(async () => {
      calls += 1;
    });

    expect(calls).toBe(1);
    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).toEqual({});
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toBeUndefined();
    expect(draftText()).toBe("");
  });

  it("leaves no pending submission behind, so no draft tab can create a second agent", async () => {
    await run(async () => undefined);

    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toEqual({});
    expect(useCreateFlowStore.getState().pendingByDraftId).toEqual({});
  });

  it("rethrows a failed creation and keeps the prompt for retry", async () => {
    const failure = new Error("daemon exploded");

    await expect(
      run(async () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    expect(draftText()).toBe("do the thing");
  });

  it("keeps a prompt typed into the shared draft while creation was in flight", async () => {
    await run(async () => {
      saveDraft("a different idea");
    });

    expect(draftText()).toBe("a different idea");
  });
});
