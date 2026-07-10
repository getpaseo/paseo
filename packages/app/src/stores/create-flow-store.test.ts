import { beforeEach, describe, expect, it } from "vitest";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "./create-flow-store";

describe("create-flow-store", () => {
  beforeEach(() => {
    useCreateFlowStore.setState({ pendingByDraftId: {} });
  });

  it("tracks lifecycle transitions explicitly", () => {
    const store = useCreateFlowStore.getState();
    store.setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
      images: [],
    });

    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]?.lifecycle).toBe("active");

    useCreateFlowStore.getState().markLifecycle({ draftId: "draft-1", lifecycle: "abandoned" });
    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]?.lifecycle).toBe("abandoned");
  });

  it("rekeys draft id idempotently", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-a",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
      images: [],
    });

    useCreateFlowStore.getState().rekeyDraft({
      fromDraftId: "draft-a",
      toDraftId: "draft-b",
    });
    useCreateFlowStore.getState().rekeyDraft({
      fromDraftId: "draft-a",
      toDraftId: "draft-b",
    });

    expect(useCreateFlowStore.getState().pendingByDraftId["draft-b"]?.draftId).toBe("draft-b");
  });

  it("supports multiple pending attempts", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "one",
      timestamp: Date.now(),
    });
    useCreateFlowStore.getState().setPending({
      draftId: "draft-2",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-2",
      text: "two",
      timestamp: Date.now(),
    });

    const state = useCreateFlowStore.getState();
    expect(Object.keys(state.pendingByDraftId).sort()).toEqual(["draft-1", "draft-2"]);

    useCreateFlowStore.getState().clear({ draftId: "draft-1" });
    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]).toBeUndefined();
  });

  it("clears pending handoff state by agent", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
    });
    useCreateFlowStore.getState().updateAgentId({ draftId: "draft-1", agentId: "agent-1" });
    useCreateFlowStore.getState().markLifecycle({ draftId: "draft-1", lifecycle: "sent" });

    useCreateFlowStore.getState().clearByAgent({ serverId: "server-1", agentId: "agent-1" });

    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]).toBeUndefined();
  });

  it("matches only active pending create flows for a draft and server", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
    });
    const pending = useCreateFlowStore.getState().pendingByDraftId["draft-1"];

    expect(
      isActiveCreateFlowForDraft({
        pending,
        serverId: "server-1",
        draftId: " draft-1 ",
      }),
    ).toBe(true);
    expect(
      isActiveCreateFlowForDraft({
        pending,
        serverId: "server-2",
        draftId: "draft-1",
      }),
    ).toBe(false);

    useCreateFlowStore.getState().markLifecycle({ draftId: "draft-1", lifecycle: "sent" });
    expect(
      isActiveCreateFlowForDraft({
        pending: useCreateFlowStore.getState().pendingByDraftId["draft-1"],
        serverId: "server-1",
        draftId: "draft-1",
      }),
    ).toBe(false);
  });
});
