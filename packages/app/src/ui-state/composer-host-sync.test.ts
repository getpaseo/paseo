import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "@/stores/draft-store";
import {
  applyRemoteComposerRecord,
  handleUiStateUpdatedForComposer,
  scheduleComposerHostUpsert,
} from "./composer-host-sync";

describe("composer host sync", () => {
  beforeEach(() => {
    useDraftStore.setState({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},
    });
    vi.useFakeTimers();
  });

  it("applyRemoteComposerRecord writes text into draft store", () => {
    applyRemoteComposerRecord({
      clientDraftKey: "agent:srv:agt_1",
      text: "from host",
      updatedAtIso: "2026-08-01T01:00:00.000Z",
    });
    expect(useDraftStore.getState().getDraftInput("agent:srv:agt_1")?.text).toBe("from host");
  });

  it("applyRemoteComposerRecord does not clobber newer local", () => {
    useDraftStore.getState().saveDraftInput({
      draftKey: "agent:srv:agt_1",
      draft: { text: "local newer", attachments: [] },
    });
    // Force a high updatedAt on local record
    const local = useDraftStore.getState().drafts["agent:srv:agt_1"];
    if (local) {
      useDraftStore.setState({
        drafts: {
          "agent:srv:agt_1": {
            ...local,
            updatedAt: Date.parse("2026-08-01T02:00:00.000Z"),
          },
        },
      });
    }
    applyRemoteComposerRecord({
      clientDraftKey: "agent:srv:agt_1",
      text: "remote older",
      updatedAtIso: "2026-08-01T01:00:00.000Z",
    });
    expect(useDraftStore.getState().getDraftInput("agent:srv:agt_1")?.text).toBe("local newer");
  });

  it("scheduleComposerHostUpsert debounces upsert calls", async () => {
    const upsertUiState = vi.fn(async () => ({
      requestId: "r",
      namespace: "composer" as const,
      key: "agent:agt_1",
      applied: true,
      record: null,
      error: null,
    }));
    const client = {
      getUiState: vi.fn(),
      upsertUiState,
      clearUiState: vi.fn(),
    };
    scheduleComposerHostUpsert({
      client,
      clientDraftKey: "agent:srv:agt_1",
      text: "a",
      attachments: [],
    });
    scheduleComposerHostUpsert({
      client,
      clientDraftKey: "agent:srv:agt_1",
      text: "ab",
      attachments: [],
    });
    expect(upsertUiState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(upsertUiState).toHaveBeenCalledTimes(1);
    const firstCall = upsertUiState.mock.calls.at(0)?.at(0) as
      | { namespace?: string; key?: string; record?: { text?: string; lifecycle?: string } }
      | undefined;
    expect(firstCall).toMatchObject({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "ab", lifecycle: "active" },
    });
  });

  it("handleUiStateUpdatedForComposer applies remote text", () => {
    handleUiStateUpdatedForComposer({
      message: {
        type: "ui_state.updated",
        namespace: "composer",
        key: "agent:agt_1",
        record: { text: "pushed", updatedAt: "2026-08-01T03:00:00.000Z" },
        updatedAt: "2026-08-01T03:00:00.000Z",
      },
      resolveClientDraftKeys: (wireKey) => (wireKey === "agent:agt_1" ? ["agent:srv:agt_1"] : []),
    });
    expect(useDraftStore.getState().getDraftInput("agent:srv:agt_1")?.text).toBe("pushed");
  });
});
