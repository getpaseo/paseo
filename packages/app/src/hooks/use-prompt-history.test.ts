/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import { useGlobalPromptHistoryStore } from "@/stores/prompt-history-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  mergePromptHistorySources,
  usePromptHistory,
  type UsePromptHistoryArgs,
  type UsePromptHistoryResult,
} from "@/hooks/use-prompt-history";

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";

function makeUserMessage(id: string, text: string, ts = Date.now()): StreamItem {
  return {
    kind: "user_message",
    id,
    text,
    timestamp: new Date(ts),
  };
}

function makeAssistantMessage(id: string, text: string, ts = Date.now()): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(ts),
  } as StreamItem;
}

function seedSessionUserMessages(messages: StreamItem[]): void {
  const session = {
    agentStreamTail: new Map([[AGENT_ID, messages]]),
    agentStreamHead: new Map<string, StreamItem[]>(),
  } as Partial<SessionState> as SessionState;
  useSessionStore.setState({
    sessions: { [SERVER_ID]: session },
  } as Partial<ReturnType<typeof useSessionStore.getState>>);
}

function seedGlobalHistory(entries: string[]): void {
  useGlobalPromptHistoryStore.setState({ entries });
}

function resetStores(): void {
  useGlobalPromptHistoryStore.setState({ entries: [] });
  useSessionStore.setState({ sessions: {} } as Partial<
    ReturnType<typeof useSessionStore.getState>
  >);
}

interface KeyEventFake {
  key: string;
  preventDefault: ReturnType<typeof vi.fn>;
}

function makeEvent(key: string): KeyEventFake {
  return { key, preventDefault: vi.fn() };
}

interface HostState {
  value: string;
  cursorIndex: number;
}

function renderPromptHistory(initial: HostState) {
  const onApply = vi.fn();
  const state = { ...initial };
  const hook = renderHook<
    UsePromptHistoryResult,
    Pick<UsePromptHistoryArgs, "value" | "cursorIndex">
  >(
    ({ value, cursorIndex }) =>
      usePromptHistory({
        value,
        cursorIndex,
        agentId: AGENT_ID,
        serverId: SERVER_ID,
        onApply,
      }),
    { initialProps: state },
  );
  return {
    onApply,
    result: hook.result,
    rerender: (next: HostState) => {
      state.value = next.value;
      state.cursorIndex = next.cursorIndex;
      hook.rerender({ ...state });
    },
  };
}

describe("mergePromptHistorySources", () => {
  it("returns global entries when no local messages", () => {
    expect(
      mergePromptHistorySources({
        localTail: [],
        localHead: [],
        globalEntries: ["older", "newer"],
      }),
    ).toEqual(["older", "newer"]);
  });

  it("appends local user messages after deduped global entries", () => {
    expect(
      mergePromptHistorySources({
        localTail: [makeUserMessage("u1", "hello")],
        localHead: [makeUserMessage("u2", "world")],
        globalEntries: ["older", "hello"],
      }),
    ).toEqual(["older", "hello", "world"]);
  });

  it("ignores assistant messages and empty user messages", () => {
    expect(
      mergePromptHistorySources({
        localTail: [
          makeUserMessage("u1", "  "),
          makeAssistantMessage("a1", "should be skipped"),
          makeUserMessage("u2", "real prompt"),
        ],
        localHead: [],
        globalEntries: [],
      }),
    ).toEqual(["real prompt"]);
  });

  it("dedupes within local list (oldest first wins)", () => {
    expect(
      mergePromptHistorySources({
        localTail: [makeUserMessage("u1", "dup"), makeUserMessage("u2", "dup")],
        localHead: [],
        globalEntries: [],
      }),
    ).toEqual(["dup"]);
  });
});

describe("usePromptHistory", () => {
  beforeEach(resetStores);

  it("returns false on ArrowUp when no history is available", () => {
    const { result } = renderPromptHistory({ value: "", cursorIndex: 0 });
    const event = makeEvent("ArrowUp");
    let consumed = false;
    act(() => {
      consumed = result.current.onKeyPress(event);
    });
    expect(consumed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("returns false on non-arrow keys", () => {
    seedGlobalHistory(["one", "two"]);
    const { result } = renderPromptHistory({ value: "", cursorIndex: 0 });
    const event = makeEvent("Enter");
    let consumed = false;
    act(() => {
      consumed = result.current.onKeyPress(event);
    });
    expect(consumed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ArrowUp on empty input recalls the latest entry", () => {
    seedGlobalHistory(["older", "newest"]);
    const { result, onApply } = renderPromptHistory({ value: "", cursorIndex: 0 });
    const event = makeEvent("ArrowUp");
    let consumed = false;
    act(() => {
      consumed = result.current.onKeyPress(event);
    });
    expect(consumed).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledWith("newest");
  });

  it("ArrowUp when cursor is not on first line is a no-op", () => {
    seedGlobalHistory(["older", "newest"]);
    const { result, onApply } = renderPromptHistory({
      value: "line1\nline2",
      cursorIndex: 8, // somewhere in line2
    });
    const event = makeEvent("ArrowUp");
    let consumed = false;
    act(() => {
      consumed = result.current.onKeyPress(event);
    });
    expect(consumed).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("repeated ArrowUp walks further back, stops at oldest", () => {
    seedGlobalHistory(["a", "b", "c"]);
    const { result, onApply, rerender } = renderPromptHistory({ value: "", cursorIndex: 0 });

    act(() => {
      result.current.onKeyPress(makeEvent("ArrowUp"));
    });
    expect(onApply).toHaveBeenLastCalledWith("c");
    rerender({ value: "c", cursorIndex: 1 });

    act(() => {
      result.current.onKeyPress(makeEvent("ArrowUp"));
    });
    expect(onApply).toHaveBeenLastCalledWith("b");
    rerender({ value: "b", cursorIndex: 1 });

    act(() => {
      result.current.onKeyPress(makeEvent("ArrowUp"));
    });
    expect(onApply).toHaveBeenLastCalledWith("a");
    rerender({ value: "a", cursorIndex: 1 });

    // One more ArrowUp at oldest: still consumed (so cursor doesn't jump)
    // but onApply should NOT fire again.
    onApply.mockClear();
    const event = makeEvent("ArrowUp");
    let consumed = false;
    act(() => {
      consumed = result.current.onKeyPress(event);
    });
    expect(consumed).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("ArrowDown after ArrowUp walks toward newest, then restores draft", () => {
    seedGlobalHistory(["a", "b", "c"]);
    const { result, onApply, rerender } = renderPromptHistory({ value: "draft", cursorIndex: 5 });

    // Up x 2
    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    rerender({ value: "c", cursorIndex: 1 });
    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    rerender({ value: "b", cursorIndex: 1 });
    expect(onApply).toHaveBeenLastCalledWith("b");

    // Down: back to "c"
    act(() => result.current.onKeyPress(makeEvent("ArrowDown")));
    expect(onApply).toHaveBeenLastCalledWith("c");
    rerender({ value: "c", cursorIndex: 1 });

    // Down again: restore the original draft and exit navigation.
    act(() => result.current.onKeyPress(makeEvent("ArrowDown")));
    expect(onApply).toHaveBeenLastCalledWith("draft");
  });

  it("ArrowDown when not navigating returns false (default cursor behavior)", () => {
    seedGlobalHistory(["a"]);
    const { result, onApply } = renderPromptHistory({ value: "", cursorIndex: 0 });
    const event = makeEvent("ArrowDown");
    let consumed = false;
    act(() => {
      consumed = result.current.onKeyPress(event);
    });
    expect(consumed).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("user typing during navigation drops the saved draft (drift unhook)", () => {
    seedGlobalHistory(["older", "newest"]);
    const { result, onApply, rerender } = renderPromptHistory({ value: "draft", cursorIndex: 5 });

    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    expect(onApply).toHaveBeenLastCalledWith("newest");

    // Simulate user editing the recalled value.
    rerender({ value: "newest!", cursorIndex: 7 });

    // ArrowDown should now be a no-op (no navigation state to walk back from).
    onApply.mockClear();
    const downEvent = makeEvent("ArrowDown");
    let consumed = false;
    act(() => {
      consumed = result.current.onKeyPress(downEvent);
    });
    expect(consumed).toBe(false);
    expect(onApply).not.toHaveBeenCalled();

    // Next ArrowUp starts a fresh navigation, capturing the edited value as draft.
    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    expect(onApply).toHaveBeenLastCalledWith("newest");
    rerender({ value: "newest", cursorIndex: 6 });

    // ArrowDown now restores the user's edited draft, not the original "draft".
    act(() => result.current.onKeyPress(makeEvent("ArrowDown")));
    expect(onApply).toHaveBeenLastCalledWith("newest!");
  });

  it("local agent messages take priority and are not duplicated by global history", () => {
    seedSessionUserMessages([
      makeUserMessage("u1", "local-1", 1),
      makeUserMessage("u2", "shared", 2),
    ]);
    seedGlobalHistory(["older-global", "shared", "stale-global"]);

    const { result, onApply, rerender } = renderPromptHistory({ value: "", cursorIndex: 0 });

    // Walking up should: shared, stale-global ... no wait, we de-dupe. Final
    // merged list (oldest-first) = [older-global, stale-global, local-1, shared].
    // First ArrowUp gives the newest = "shared".
    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    expect(onApply).toHaveBeenLastCalledWith("shared");
    rerender({ value: "shared", cursorIndex: 6 });

    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    expect(onApply).toHaveBeenLastCalledWith("local-1");
    rerender({ value: "local-1", cursorIndex: 7 });

    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    expect(onApply).toHaveBeenLastCalledWith("stale-global");
    rerender({ value: "stale-global", cursorIndex: 12 });

    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    expect(onApply).toHaveBeenLastCalledWith("older-global");
  });

  it("reset() drops navigation state so next ArrowUp starts fresh", () => {
    seedGlobalHistory(["a", "b"]);
    const { result, onApply, rerender } = renderPromptHistory({ value: "draft", cursorIndex: 5 });

    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    expect(onApply).toHaveBeenLastCalledWith("b");

    act(() => {
      result.current.reset();
    });
    rerender({ value: "", cursorIndex: 0 });

    onApply.mockClear();
    act(() => result.current.onKeyPress(makeEvent("ArrowUp")));
    // Fresh navigation: should call with newest again.
    expect(onApply).toHaveBeenLastCalledWith("b");
  });
});
