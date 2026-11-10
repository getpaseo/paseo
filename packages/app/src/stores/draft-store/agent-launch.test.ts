import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore, type AgentLaunchDraftMetadata } from "@/stores/draft-store";
import { PersistedDraftStoreSchema } from "./migration";
import { DRAFT_STORE_VERSION, keepsEmptiedDraftBound } from "./state";

const metadata: AgentLaunchDraftMetadata = {
  draftId: "draft-1",
  serverId: "host-1",
  pluginId: "todo",
  projectId: "project-1",
  launchId: "attempt-1",
  documentIncarnationId: "incarnation-1",
  journalKey: "@paseo:plugin-agent-launch:v1:host-1:todo:incarnation-1:attempt-1",
  requestFingerprint: "fingerprint-1",
  labels: { "paseo.plugin.todo": "v1", "paseo.plugin.todo.attempt-id": "attempt-1" },
  clientMessageId: "message-1",
  submissionState: "editable",
};
const DRAFT_KEY = "draft:host-1:draft-1";

beforeEach(() => {
  useDraftStore.setState({ drafts: {} });
});

describe("draft-store agent launch metadata", () => {
  it("binds metadata by draft ID and keeps it across later text edits", () => {
    const store = useDraftStore.getState();
    store.setAgentLaunchMetadata({
      draftKey: DRAFT_KEY,
      draft: { text: "seed prompt", attachments: [] },
      metadata,
    });
    expect(store.getAgentLaunchMetadata("draft-1")).toEqual(metadata);

    store.saveDraftInput({
      draftKey: DRAFT_KEY,
      draft: { text: "edited by the user", attachments: [] },
    });
    expect(useDraftStore.getState().drafts[DRAFT_KEY]).toMatchObject({
      input: { text: "edited by the user" },
      agentLaunch: metadata,
    });
    expect(useDraftStore.getState().getAgentLaunchMetadata("draft-1")).toEqual(metadata);
    expect(useDraftStore.getState().getAgentLaunchMetadata("other")).toBeUndefined();
  });

  it("keeps only launch drafts bound when their content is emptied", () => {
    const store = useDraftStore.getState();
    store.saveDraftInput({ draftKey: "draft:host-1:plain", draft: { text: "x", attachments: [] } });
    store.setAgentLaunchMetadata({
      draftKey: DRAFT_KEY,
      draft: { text: "seed prompt", attachments: [] },
      metadata,
    });
    const drafts = useDraftStore.getState().drafts;
    expect(keepsEmptiedDraftBound(drafts[DRAFT_KEY])).toBe(true);
    expect(keepsEmptiedDraftBound(drafts["draft:host-1:plain"])).toBe(false);
    expect(keepsEmptiedDraftBound(undefined)).toBe(false);
  });

  it("keeps a launch draft active and bound when typing empties its text", () => {
    const store = useDraftStore.getState();
    store.setAgentLaunchMetadata({
      draftKey: DRAFT_KEY,
      draft: { text: "seed prompt", attachments: [] },
      metadata,
    });

    store.editDraftText({ draftKey: DRAFT_KEY, text: "edited by the user" });
    expect(useDraftStore.getState().drafts[DRAFT_KEY]).toMatchObject({
      lifecycle: "active",
      input: { text: "edited by the user" },
      agentLaunch: metadata,
    });

    // Select-all + delete is an edit, not a close: abandoning would discard the launch journal.
    store.editDraftText({ draftKey: DRAFT_KEY, text: "" });
    expect(useDraftStore.getState().drafts[DRAFT_KEY]).toMatchObject({
      lifecycle: "active",
      input: { text: "" },
      agentLaunch: metadata,
    });
    expect(useDraftStore.getState().getAgentLaunchMetadata("draft-1")).toEqual(metadata);
  });

  it("updates only the submission state and bumps the record version", () => {
    const store = useDraftStore.getState();
    store.setAgentLaunchMetadata({
      draftKey: DRAFT_KEY,
      draft: { text: "seed prompt", attachments: [] },
      metadata,
    });
    const before = useDraftStore.getState().drafts[DRAFT_KEY]!.version;
    store.updateAgentLaunchSubmissionState({
      draftId: "draft-1",
      submissionState: "outcome_unknown_readonly",
    });
    const record = useDraftStore.getState().drafts[DRAFT_KEY]!;
    expect(record.agentLaunch).toEqual({
      ...metadata,
      submissionState: "outcome_unknown_readonly",
    });
    expect(record.version).toBe(before + 1);
    expect(record.input.text).toBe("seed prompt");

    // Idempotent: the same state does not rewrite the record.
    store.updateAgentLaunchSubmissionState({
      draftId: "draft-1",
      submissionState: "outcome_unknown_readonly",
    });
    expect(useDraftStore.getState().drafts[DRAFT_KEY]!.version).toBe(before + 1);
  });

  it("keeps the binding on a cleared tombstone so the journal can still be resolved", () => {
    const store = useDraftStore.getState();
    store.setAgentLaunchMetadata({
      draftKey: DRAFT_KEY,
      draft: { text: "seed prompt", attachments: [] },
      metadata,
    });
    store.clearDraftInput({ draftKey: DRAFT_KEY, lifecycle: "sent" });
    expect(useDraftStore.getState().drafts[DRAFT_KEY]).toMatchObject({
      lifecycle: "sent",
      input: { text: "" },
      agentLaunch: metadata,
    });
  });

  it("persists metadata in the current store version schema", () => {
    expect(DRAFT_STORE_VERSION).toBe(6);
    const persisted = PersistedDraftStoreSchema.parse({
      drafts: {
        [DRAFT_KEY]: {
          input: { text: "seed prompt", attachments: [] },
          lifecycle: "active",
          agentLaunch: metadata,
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    });
    expect(
      (persisted.drafts as Record<string, { agentLaunch?: unknown }>)[DRAFT_KEY]?.agentLaunch,
    ).toEqual(metadata);
  });
});
