/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimTerminalRecording,
  clearTerminalDictationState,
  getTerminalInputSink,
  getTerminalRecordingOwnerId,
  publishTerminalDictationState,
  registerTerminalInputSink,
  releaseTerminalRecording,
  useRegisterTerminalInputSink,
  useTerminalDictationState,
  useTerminalInputSink,
  type TerminalDictationState,
  type TerminalInputSink,
} from "./index";

function fakeSink(): TerminalInputSink {
  return {
    pasteText: () => {},
    deliverFiles: () => {},
    focus: () => {},
    dictation: {
      ownerId: "owner",
      toggle: () => {},
      cancel: () => {},
      confirm: () => {},
      retry: () => {},
      discard: () => {},
    },
  };
}

function dictationState(volume: number): TerminalDictationState {
  return {
    status: "recording",
    isRecording: true,
    isProcessing: false,
    error: null,
    duration: 0,
    volume,
  };
}

const cleanups: Array<() => void> = [];

function register(serverId: string, terminalId: string, sink: TerminalInputSink): () => void {
  let cleanup = () => {};
  act(() => {
    cleanup = registerTerminalInputSink(serverId, terminalId, sink);
  });
  const remove = () => act(() => cleanup());
  cleanups.push(remove);
  return remove;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("terminal input sinks", () => {
  it("finds a registered sink by its exact server and terminal", () => {
    const sink = fakeSink();
    register("server-a", "term-1", sink);

    expect(getTerminalInputSink("server-a", "term-1")).toBe(sink);
    expect(getTerminalInputSink("server-a", "term-2")).toBeNull();
    expect(getTerminalInputSink("server-b", "term-1")).toBeNull();
  });

  it("lets a newer pane replace a terminal's sink and ignores the older pane's late cleanup", () => {
    const older = fakeSink();
    const newer = fakeSink();
    const removeOlder = register("server-a", "term-1", older);
    const removeNewer = register("server-a", "term-1", newer);

    expect(getTerminalInputSink("server-a", "term-1")).toBe(newer);
    removeOlder();
    expect(getTerminalInputSink("server-a", "term-1")).toBe(newer);
    removeNewer();
    expect(getTerminalInputSink("server-a", "term-1")).toBeNull();
  });

  it("removes only its own terminal's entry", () => {
    const first = fakeSink();
    const second = fakeSink();
    const removeFirst = register("server-a", "term-1", first);
    register("server-a", "term-2", second);

    removeFirst();

    expect(getTerminalInputSink("server-a", "term-1")).toBeNull();
    expect(getTerminalInputSink("server-a", "term-2")).toBe(second);
  });

  it("re-renders a terminal's controls only for changes to that terminal", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTerminalInputSink("server-a", "term-1");
    });
    expect(result.current).toBeNull();
    const rendersBefore = renders;

    register("server-a", "term-2", fakeSink());
    expect(renders).toBe(rendersBefore);

    const sink = fakeSink();
    register("server-a", "term-1", sink);
    expect(result.current).toBe(sink);
    expect(renders).toBe(rendersBefore + 1);
  });

  it("registers a pane's sink while mounted and removes it on unmount", () => {
    const sink = fakeSink();
    const { unmount } = renderHook(() => useRegisterTerminalInputSink("server-a", "term-1", sink));

    expect(getTerminalInputSink("server-a", "term-1")).toBe(sink);
    unmount();
    expect(getTerminalInputSink("server-a", "term-1")).toBeNull();
  });
});

describe("terminal dictation state", () => {
  afterEach(() => {
    act(() => {
      clearTerminalDictationState("owner-a");
      clearTerminalDictationState("owner-b");
      releaseTerminalRecording("owner-a");
      releaseTerminalRecording("owner-b");
    });
  });

  it("re-renders an owner's controls only for that owner's state", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTerminalDictationState("owner-a");
    });
    expect(result.current).toBeNull();
    const rendersBefore = renders;

    act(() => publishTerminalDictationState("owner-b", dictationState(0.5)));
    expect(renders).toBe(rendersBefore);

    const published = dictationState(0.2);
    act(() => publishTerminalDictationState("owner-a", published));
    expect(result.current).toBe(published);

    act(() => clearTerminalDictationState("owner-a"));
    expect(result.current).toBeNull();
  });

  it("keeps one recording owner and releases it only for that owner", () => {
    act(() => claimTerminalRecording("owner-a"));
    expect(getTerminalRecordingOwnerId()).toBe("owner-a");

    act(() => claimTerminalRecording("owner-b"));
    expect(getTerminalRecordingOwnerId()).toBe("owner-b");

    act(() => releaseTerminalRecording("owner-a"));
    expect(getTerminalRecordingOwnerId()).toBe("owner-b");
    act(() => releaseTerminalRecording("owner-b"));
    expect(getTerminalRecordingOwnerId()).toBeNull();
  });
});
