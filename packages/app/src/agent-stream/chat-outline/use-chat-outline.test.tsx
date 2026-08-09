// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamViewportHandle } from "../strategy";
import { useChatOutline } from "./use-chat-outline";

interface RefreshMessage {
  type: "agent_stream";
  payload: {
    agentId: string;
    event: { type: "timeline"; item: { type: "user_message" } };
  };
}

const runtime = vi.hoisted(() => ({
  listAgentTimelinePrompts: vi.fn(),
  fetchAgentTimeline: vi.fn(),
  on: vi.fn<(event: string, listener: (message: RefreshMessage) => void) => () => void>(
    () => () => undefined,
  ),
}));

vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => runtime,
    fetchAgentTimeline: runtime.fetchAgentTimeline,
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("useChatOutline", () => {
  beforeEach(() => {
    runtime.listAgentTimelinePrompts.mockReset();
    runtime.fetchAgentTimeline.mockReset();
    runtime.on.mockClear();
  });

  it("drops a late prompt index after the authoritative timeline epoch changes", async () => {
    const first = deferred<{ epoch: string; prompts: [] }>();
    const second = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    runtime.listAgentTimelinePrompts
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ timelineEpoch }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch,
          tail: [],
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { timelineEpoch: "epoch-1" } },
    );
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));

    rerender({ timelineEpoch: "epoch-2" });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve({ epoch: "epoch-1", prompts: [] }));
    expect(result.current.prompts).toEqual([]);

    await act(async () =>
      second.resolve({
        epoch: "epoch-2",
        prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "current prompt" }],
      }),
    );
    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(1);
    });
    expect(result.current.prompts[0]?.seq).toBe(2);
  });

  it("keeps the newest prompt index response within one epoch", async () => {
    const older = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    const newer = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    runtime.listAgentTimelinePrompts
      .mockResolvedValueOnce({ epoch: "epoch-1", prompts: [] })
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result } = renderHook(() =>
      useChatOutline({
        agentId: "agent-1",
        serverId: "server-1",
        timelineEpoch: "epoch-1",
        tail: [],
        head: [],
        enabled: true,
        viewportRef,
        onJumpError: vi.fn(),
      }),
    );
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));
    const refresh = runtime.on.mock.calls[0]?.[1];
    await act(async () => {
      refresh?.({
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          event: { type: "timeline", item: { type: "user_message" } },
        },
      });
      refresh?.({
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          event: { type: "timeline", item: { type: "user_message" } },
        },
      });
    });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(3));
    await act(async () =>
      newer.resolve({
        epoch: "epoch-1",
        prompts: [{ seq: 3, timestamp: new Date(3).toISOString(), preview: "newer" }],
      }),
    );
    await act(async () =>
      older.resolve({
        epoch: "epoch-1",
        prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "older" }],
      }),
    );

    expect(result.current.prompts.map((prompt) => prompt.seq)).toEqual([3]);
  });

  it("reports a failed unloaded prompt jump", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "prompt" }],
    });
    runtime.fetchAgentTimeline.mockRejectedValue(new Error("disconnected"));
    const onJumpError = vi.fn();
    const viewportRef = createRef<StreamViewportHandle>();
    const { result } = renderHook(() =>
      useChatOutline({
        agentId: "agent-1",
        serverId: "server-1",
        timelineEpoch: "epoch-1",
        tail: [],
        head: [],
        enabled: true,
        viewportRef,
        onJumpError,
      }),
    );
    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    await act(async () => result.current.jumpToPrompt(1));

    await waitFor(() => expect(onJumpError).toHaveBeenCalledOnce());
  });
});
