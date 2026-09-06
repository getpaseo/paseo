import { describe, expect, it } from "vitest";
import { useSessionStore } from "@/stores/session-store";

interface TimelineItem {
  id: string;
  type: "user_message" | "assistant_message" | "tool_call";
  messageId?: string;
  text?: string;
}

interface TimelineState {
  items: TimelineItem[];
  isRewinding: boolean;
  targetMessageId: string | null;
  epoch: number;
}

/**
 * Optimistic timeline truncation reducer (Zed / Cursor pattern).
 * Slices the timeline cleanly up to the target message without clearing the whole list
 * or resetting the epoch, preventing full view teardown and UI flashes.
 */
export function optimisticTimelineTruncate(
  state: TimelineState,
  targetMessageId: string,
): TimelineState {
  const targetIndex = state.items.findIndex(
    (item) => item.messageId === targetMessageId || item.id === targetMessageId,
  );

  if (targetIndex === -1) {
    return state;
  }

  // Keep all items up to the user message being rewound to
  const truncatedItems = state.items.slice(0, targetIndex + 1);

  return {
    ...state,
    items: truncatedItems,
    isRewinding: true,
    targetMessageId,
    // Epoch is preserved so the view does not remount from scratch
    epoch: state.epoch,
  };
}

/**
 * Settles the rewind when the server sends authoritative confirmation.
 */
export function settleTimelineRewind(
  state: TimelineState,
  authoritativeItems: TimelineItem[],
): TimelineState {
  return {
    ...state,
    items: authoritativeItems,
    isRewinding: false,
    targetMessageId: null,
  };
}

describe("Optimistic Timeline Truncation (Zero-Flash Rewind)", () => {
  it("truncates timeline items up to the target message without tearing down the list", () => {
    const initialState: TimelineState = {
      epoch: 1,
      isRewinding: false,
      targetMessageId: null,
      items: [
        { id: "msg-1", type: "user_message", messageId: "msg-1", text: "First prompt" },
        { id: "msg-2", type: "assistant_message", text: "First reply" },
        { id: "tool-1", type: "tool_call", text: "read file" },
        { id: "msg-3", type: "user_message", messageId: "msg-3", text: "Second prompt" },
        { id: "msg-4", type: "assistant_message", text: "Second reply" },
        { id: "msg-5", type: "user_message", messageId: "msg-5", text: "Third prompt" },
        { id: "msg-6", type: "assistant_message", text: "Third reply" },
      ],
    };

    // User rewinds back to "Second prompt" (msg-3)
    const nextState = optimisticTimelineTruncate(initialState, "msg-3");

    expect(nextState.isRewinding).toBe(true);
    expect(nextState.targetMessageId).toBe("msg-3");
    expect(nextState.epoch).toBe(1); // Epoch preserved (prevents full stream unmount)
    expect(nextState.items).toHaveLength(4);
    expect(nextState.items.map((i) => i.id)).toEqual(["msg-1", "msg-2", "tool-1", "msg-3"]);
  });

  it("handles non-existent target gracefully without mutating items", () => {
    const initialState: TimelineState = {
      epoch: 1,
      isRewinding: false,
      targetMessageId: null,
      items: [
        { id: "msg-1", type: "user_message", messageId: "msg-1", text: "Prompt" },
        { id: "msg-2", type: "assistant_message", text: "Reply" },
      ],
    };

    const nextState = optimisticTimelineTruncate(initialState, "non-existent");
    expect(nextState.items).toHaveLength(2);
    expect(nextState.isRewinding).toBe(false);
  });

  it("settles smoothly with authoritative backend items without flashing", () => {
    const optimisticState: TimelineState = {
      epoch: 1,
      isRewinding: true,
      targetMessageId: "msg-3",
      items: [
        { id: "msg-1", type: "user_message", messageId: "msg-1", text: "First prompt" },
        { id: "msg-2", type: "assistant_message", text: "First reply" },
        { id: "msg-3", type: "user_message", messageId: "msg-3", text: "Second prompt" },
      ],
    };

    const authoritativeItems: TimelineItem[] = [
      { id: "msg-1", type: "user_message", messageId: "msg-1", text: "First prompt" },
      { id: "msg-2", type: "assistant_message", text: "First reply" },
      { id: "msg-3", type: "user_message", messageId: "msg-3", text: "Second prompt" },
    ];

    const settledState = settleTimelineRewind(optimisticState, authoritativeItems);
    expect(settledState.isRewinding).toBe(false);
    expect(settledState.targetMessageId).toBeNull();
    expect(settledState.items).toEqual(authoritativeItems);
  });
});

describe("Session Store Optimistic Truncation & Rollback Guard", () => {
  const serverId = "test-server-1";
  const agentId = "agent-1";

  it("truncates agentStreamTail at targeted messageId and clears head", () => {
    const store = useSessionStore.getState();
    const msg1 = {
      id: "msg-1",
      kind: "user_message" as const,
      messageId: "msg-1",
      text: "First prompt",
    };
    const msg2 = {
      id: "msg-2",
      kind: "user_message" as const,
      messageId: "msg-2",
      text: "Second prompt",
    };
    const msg3 = {
      id: "msg-3",
      kind: "user_message" as const,
      messageId: "msg-3",
      text: "Third prompt",
    };

    store.ensureSession(serverId);
    store.setAgentStreamState(serverId, agentId, {
      tail: [msg1, msg2, msg3],
      head: [{ id: "head-1", kind: "user_message", text: "streaming..." }],
    });

    const truncated = store.truncateAgentStreamTailAtMessageId(serverId, agentId, "msg-2");
    expect(truncated).toHaveLength(2);
    expect(truncated?.map((i) => i.id)).toEqual(["msg-1", "msg-2"]);

    const currentSession = useSessionStore.getState().sessions[serverId];
    expect(currentSession?.agentStreamTail.get(agentId)).toEqual([msg1, msg2]);
    expect(currentSession?.agentStreamHead.has(agentId)).toBe(false);
  });

  it("rolls back optimistic truncation cleanly when unchanged", () => {
    const store = useSessionStore.getState();
    const msg1 = {
      id: "msg-1",
      kind: "user_message" as const,
      messageId: "msg-1",
      text: "First prompt",
    };
    const msg2 = {
      id: "msg-2",
      kind: "user_message" as const,
      messageId: "msg-2",
      text: "Second prompt",
    };

    store.ensureSession(serverId);
    store.setAgentStreamState(serverId, agentId, {
      tail: [msg1, msg2],
    });

    const previousTail = [msg1, msg2];
    const truncated = store.truncateAgentStreamTailAtMessageId(serverId, agentId, "msg-1");
    expect(truncated).toHaveLength(1);

    const rolledBack = store.rollbackOptimisticStreamTruncation(
      serverId,
      agentId,
      truncated!,
      previousTail,
      undefined,
    );
    expect(rolledBack).toBe(true);
    expect(useSessionStore.getState().sessions[serverId]?.agentStreamTail.get(agentId)).toEqual([
      msg1,
      msg2,
    ]);
  });

  it("refuses rollback when newer stream events modified the tail", () => {
    const store = useSessionStore.getState();
    const msg1 = {
      id: "msg-1",
      kind: "user_message" as const,
      messageId: "msg-1",
      text: "First prompt",
    };
    const msg2 = {
      id: "msg-2",
      kind: "user_message" as const,
      messageId: "msg-2",
      text: "Second prompt",
    };

    store.ensureSession(serverId);
    store.setAgentStreamState(serverId, agentId, {
      tail: [msg1, msg2],
    });

    const previousTail = [msg1, msg2];
    const truncated = store.truncateAgentStreamTailAtMessageId(serverId, agentId, "msg-1");

    // Simulate another stream event modifying the tail in the meantime
    const msgNew = {
      id: "msg-new",
      kind: "user_message" as const,
      messageId: "msg-new",
      text: "New prompt",
    };
    store.setAgentStreamState(serverId, agentId, {
      tail: [msg1, msgNew],
    });

    // Rollback attempt must be rejected because tail changed!
    const rolledBack = store.rollbackOptimisticStreamTruncation(
      serverId,
      agentId,
      truncated!,
      previousTail,
      undefined,
    );
    expect(rolledBack).toBe(false);
    // Tail must NOT be overwritten with the stale pre-request snapshot!
    expect(useSessionStore.getState().sessions[serverId]?.agentStreamTail.get(agentId)).toEqual([
      msg1,
      msgNew,
    ]);
  });
});
