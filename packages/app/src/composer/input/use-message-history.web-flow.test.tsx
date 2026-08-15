/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { useMessageHistory } from "./use-message-history";

/**
 * Drives the hook with the same wiring the Composer uses on web (setValue
 * moves the cursor to the end of the new text) and seeds the daemon-backed
 * stream the hook now reads from. Covers the picker interaction; the source
 * being the agent's stream means the first message is recallable for free.
 */

const SERVER = "srv-test";

const press = (
  handle: (event: { key: string; preventDefault: () => void }) => boolean,
  key: string,
) => handle({ key, preventDefault: () => {} });

function seedUserMessages(agentId: string, texts: string[]): void {
  const items: StreamItem[] = texts.map((text, index) => ({
    kind: "user_message",
    id: `${agentId}:${index}`,
    text,
    timestamp: new Date(index),
  })) as StreamItem[];
  useSessionStore.setState((state) => {
    const prev = state.sessions[SERVER] as SessionState | undefined;
    const tail = new Map(prev?.agentStreamTail ?? []).set(agentId, items);
    return {
      ...state,
      sessions: { ...state.sessions, [SERVER]: { ...prev, agentStreamTail: tail } as SessionState },
    };
  });
}

function renderHistory(agentId: string) {
  let lastValue = "";
  const { result } = renderHook(() => {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);
    lastValue = value;
    return useMessageHistory({
      agentId,
      serverId: SERVER,
      value,
      setValue: (next: string) => {
        setValue(next);
        setCursor(next.length);
      },
      cursorIndex: cursor,
    });
  });
  return { result, getLastValue: () => lastValue };
}

describe("useMessageHistory (picker)", () => {
  it("opens on ArrowUp, navigates with arrows, selects on Enter", () => {
    seedUserMessages("open", ["first", "second"]);
    const { result, getLastValue } = renderHistory("open");
    expect(result.current.popover.visible).toBe(false);

    // ArrowUp on an empty input opens at the newest entry; input is not filled.
    act(() => expect(press(result.current.handleHistoryKey, "ArrowUp")).toBe(true));
    expect(result.current.popover.visible).toBe(true);
    expect(result.current.popover.selectedIndex).toBe(1);
    expect(result.current.popover.options.map((o) => o.label)).toEqual(["first", "second"]);
    expect(getLastValue()).toBe("");

    // ArrowUp moves toward older; input stays empty in picker mode.
    act(() => expect(press(result.current.handleHistoryKey, "ArrowUp")).toBe(true));
    expect(result.current.popover.selectedIndex).toBe(0);
    expect(getLastValue()).toBe("");

    // Enter selects the highlighted message, fills the input, and closes.
    act(() => expect(press(result.current.handleHistoryKey, "Enter")).toBe(true));
    expect(getLastValue()).toBe("first");
    expect(result.current.popover.visible).toBe(false);
  });

  it("Escape closes the popover without filling the input", () => {
    seedUserMessages("escape", ["only"]);
    const { result, getLastValue } = renderHistory("escape");
    act(() => press(result.current.handleHistoryKey, "ArrowUp"));
    expect(result.current.popover.visible).toBe(true);

    act(() => expect(press(result.current.handleHistoryKey, "Escape")).toBe(true));
    expect(result.current.popover.visible).toBe(false);
    expect(getLastValue()).toBe("");
  });

  it("does not open when the input is not empty", () => {
    seedUserMessages("guard", ["first"]);
    const { result } = renderHistory("guard");
    act(() => press(result.current.handleHistoryKey, "ArrowUp"));
    act(() => press(result.current.handleHistoryKey, "Enter"));
    // Now value === "first"; ArrowUp must not reopen (multi-line nav should work).
    act(() => expect(press(result.current.handleHistoryKey, "ArrowUp")).toBe(false));
    expect(result.current.popover.visible).toBe(false);
  });

  it("recalls the first (oldest) message, sourced from the agent stream", () => {
    // The first message lives in the daemon stream; no special recording needed.
    seedUserMessages("created", ["creation first message", "follow up"]);
    const { result, getLastValue } = renderHistory("created");

    act(() => press(result.current.handleHistoryKey, "ArrowUp")); // newest = "follow up"
    act(() => press(result.current.handleHistoryKey, "ArrowUp")); // older = "creation first message"
    expect(result.current.popover.selectedIndex).toBe(0);
    act(() => press(result.current.handleHistoryKey, "Enter"));
    expect(getLastValue()).toBe("creation first message");
  });
});
