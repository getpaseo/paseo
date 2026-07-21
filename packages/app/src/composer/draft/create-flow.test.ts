/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { useDraftAgentCreateFlow, type DraftCreateAttempt } from "./create-flow";

describe("useDraftAgentCreateFlow", () => {
  beforeEach(() => {
    useCreateFlowStore.setState({ pendingByDraftId: {} });
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
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

  it("does not resume an agent-context create attempt on a host without support", async () => {
    const attempt: DraftCreateAttempt = {
      clientMessageId: "msg-agent-context",
      text: "Use the attached context",
      timestamp: new Date("2026-07-22T00:00:00.000Z"),
      attachments: [{ type: "agent_context", agentId: "source-agent" }],
    };
    const createRequest = vi.fn(async () => ({
      agentId: "agent-1",
      result: { id: "agent-1" },
    }));
    const onBeforeSubmit = vi.fn();
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        "server-1": {
          serverInfo: { features: { agentContextAttachments: false } },
        } as (typeof state.sessions)[string],
      },
    }));

    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-1",
        getPendingServerId: () => "server-1",
        initialAttempt: attempt,
        buildDraftAgent: (currentAttempt) => ({ currentAttempt }),
        createRequest,
        onBeforeSubmit,
        onCreateSuccess: vi.fn(),
      }),
    );

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.continueCreateFromAttempt({ attempt, cwd: "/repo" });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(onBeforeSubmit).not.toHaveBeenCalled();
    expect(createRequest).not.toHaveBeenCalled();
    expect(result.current.formErrorMessage).not.toBe("");
  });
});
