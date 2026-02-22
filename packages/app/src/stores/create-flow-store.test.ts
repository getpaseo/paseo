import { beforeEach, describe, expect, it } from "vitest";
import { useCreateFlowStore } from "./create-flow-store";

describe("create-flow-store", () => {
  beforeEach(() => {
    useCreateFlowStore.setState({ pending: null });
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

    expect(useCreateFlowStore.getState().pending?.lifecycle).toBe("active");

    useCreateFlowStore.getState().markLifecycle("abandoned");
    expect(useCreateFlowStore.getState().pending?.lifecycle).toBe("abandoned");
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

    expect(useCreateFlowStore.getState().pending?.draftId).toBe("draft-b");
  });
});
