/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { useDraftAgentCreateFlow, type DraftCreateAttempt } from "./create-flow";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useDraftAgentCreateFlow", () => {
  beforeEach(() => {
    useCreateFlowStore.setState({ pendingByDraftId: {} });
  });

  it("renders a prepared new-workspace submission before continuing it", async () => {
    const image: UserMessageImageAttachment = {
      id: "image-1",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "image-key",
      createdAt: 123,
    };
    const attachment = {
      type: "review",
      cwd: "/repo",
      summary: "Review",
    } as unknown as AgentAttachment;
    const attempt: DraftCreateAttempt = {
      clientMessageId: "msg-prepared",
      text: "build this",
      timestamp: new Date("2026-05-25T00:00:00.000Z"),
      images: [image],
      attachments: [attachment],
    };
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: attempt.clientMessageId,
      text: attempt.text,
      timestamp: attempt.timestamp.getTime(),
      images: [image],
      attachments: [attachment],
    });
    const createRequest = vi.fn(
      async (ctx: {
        attempt: DraftCreateAttempt;
        text: string;
        images?: UserMessageImageAttachment[];
        attachments?: AgentAttachment[];
        cwd: string;
      }) => ({
        agentId: "agent-1",
        result: { id: "agent-1", ctx },
      }),
    );
    const onCreateSuccess = vi.fn();

    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-1",
        getPendingServerId: () => "server-1",
        initialAttempt: attempt,
        buildDraftAgent: (currentAttempt) => ({ currentAttempt }),
        createRequest,
        onCreateSuccess,
      }),
    );

    expect(result.current.isSubmitting).toBe(true);
    expect(result.current.draftAgent).toEqual({ currentAttempt: attempt });
    expect(result.current.submittedStreamItems).toEqual([
      {
        kind: "user_message",
        id: "msg-prepared",
        clientMessageId: "msg-prepared",
        text: "build this",
        timestamp: attempt.timestamp,
        images: [image],
        attachments: [attachment],
      },
    ]);
    expect(createRequest).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.continueCreateFromAttempt({ attempt, cwd: "/repo" });
    });

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest).toHaveBeenCalledWith({
      attempt,
      text: "build this",
      images: [image],
      attachments: [attachment],
      cwd: "/repo",
    });
    expect(onCreateSuccess).toHaveBeenCalledTimes(1);
  });

  it("allows retrying an empty prompt when the draft still has context attachments", async () => {
    const attachment = {
      kind: "chat_history",
      id: "chat-history-1",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Chat history",
        text: "Previous conversation",
      },
      source: {
        serverId: "server-1",
        agentId: "agent-source",
      },
    } as const;
    const createRequest = vi.fn(async () => ({
      agentId: "agent-1",
      result: { id: "agent-1" },
    }));
    const onCreateSuccess = vi.fn();
    const validateBeforeSubmit = vi.fn(() => null);

    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-1",
        getPendingServerId: () => "server-1",
        buildDraftAgent: (currentAttempt) => ({ currentAttempt }),
        createRequest,
        onCreateSuccess,
        validateBeforeSubmit,
      }),
    );

    await act(async () => {
      await result.current.handleCreateFromInput({
        text: "   ",
        attachments: [attachment],
        cwd: "/repo",
      });
    });

    expect(validateBeforeSubmit).toHaveBeenCalledWith({
      text: "",
      attachments: [attachment],
      cwd: "/repo",
    });
    expect(createRequest).toHaveBeenCalledWith({
      attempt: expect.objectContaining({
        text: "",
        attachments: [attachment.attachment],
      }),
      text: "",
      attachments: [attachment.attachment],
      cwd: "/repo",
    });
    expect(onCreateSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps a restored in-flight attempt locked without re-sending it", async () => {
    const attempt: DraftCreateAttempt = {
      clientMessageId: "msg-in-flight",
      text: "build this",
      timestamp: new Date("2026-05-25T00:00:00.000Z"),
    };
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: attempt.clientMessageId,
      text: attempt.text,
      timestamp: attempt.timestamp.getTime(),
    });
    const createRequest = vi.fn(async () => ({ agentId: "agent-1", result: { id: "agent-1" } }));

    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-1",
        getPendingServerId: () => "server-1",
        initialAttempt: attempt,
        buildDraftAgent: (currentAttempt) => ({ currentAttempt }),
        createRequest,
        onCreateSuccess: vi.fn(),
      }),
    );

    expect(result.current.isSubmitting).toBe(true);
    expect(createRequest).not.toHaveBeenCalled();
    await expect(
      result.current.handleCreateFromInput({ text: "again", attachments: [], cwd: "/repo" }),
    ).rejects.toThrow();
    expect(createRequest).not.toHaveBeenCalled();

    act(() => {
      useCreateFlowStore.getState().markLifecycle({ draftId: "draft-1", lifecycle: "sent" });
    });
    expect(result.current.isSubmitting).toBe(true);

    act(() => {
      useCreateFlowStore.getState().clear({ draftId: "draft-1" });
    });
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.formErrorMessage).toBe("");
  });

  it("leaves the store and tab alone when a newer attempt replaced this one", async () => {
    const createStarted = createDeferred<void>();
    const createResult = createDeferred<{ agentId: string; result: { id: string } }>();
    const createRequest = vi.fn(() => {
      createStarted.resolve();
      return createResult.promise;
    });
    const onCreateSuccess = vi.fn();

    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-1",
        getPendingServerId: () => "server-1",
        buildDraftAgent: (currentAttempt) => ({ currentAttempt }),
        createRequest,
        onCreateSuccess,
      }),
    );

    let submission: Promise<void> = Promise.resolve();
    await act(async () => {
      submission = result.current.handleCreateFromInput({
        text: "first",
        attachments: [],
        cwd: "/repo",
      });
      await createStarted.promise;
    });
    expect(createRequest).toHaveBeenCalledTimes(1);

    act(() => {
      useCreateFlowStore.getState().setPending({
        draftId: "draft-1",
        serverId: "server-1",
        agentId: null,
        clientMessageId: "msg-newer",
        text: "second",
        timestamp: new Date("2026-05-25T00:01:00.000Z").getTime(),
      });
    });
    await act(async () => {
      createResult.resolve({ agentId: "agent-old", result: { id: "agent-old" } });
      await submission;
    });

    expect(onCreateSuccess).not.toHaveBeenCalled();
    const pending = useCreateFlowStore.getState().pendingByDraftId["draft-1"];
    expect(pending?.clientMessageId).toBe("msg-newer");
    expect(pending?.agentId).toBeNull();
    expect(pending?.lifecycle).toBe("active");
  });
});
