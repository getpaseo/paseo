import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import {
  PROMPT_HISTORY_MAX_ENTRIES,
  useGlobalPromptHistoryStore,
} from "@/stores/prompt-history-store";

function reset(): void {
  useGlobalPromptHistoryStore.setState({ entries: [] });
}

describe("prompt-history-store", () => {
  beforeEach(reset);

  it("starts empty", () => {
    expect(useGlobalPromptHistoryStore.getState().entries).toEqual([]);
  });

  it("pushes prompts oldest-first", () => {
    const { pushPrompt } = useGlobalPromptHistoryStore.getState();
    pushPrompt("first");
    pushPrompt("second");
    pushPrompt("third");
    expect(useGlobalPromptHistoryStore.getState().entries).toEqual(["first", "second", "third"]);
  });

  it("trims whitespace from incoming prompts", () => {
    useGlobalPromptHistoryStore.getState().pushPrompt("  hello world  \n");
    expect(useGlobalPromptHistoryStore.getState().entries).toEqual(["hello world"]);
  });

  it("ignores empty and whitespace-only prompts", () => {
    const { pushPrompt } = useGlobalPromptHistoryStore.getState();
    pushPrompt("");
    pushPrompt("   ");
    pushPrompt("\n\t");
    expect(useGlobalPromptHistoryStore.getState().entries).toEqual([]);
  });

  it("deduplicates by moving the prior occurrence to the end", () => {
    const { pushPrompt } = useGlobalPromptHistoryStore.getState();
    pushPrompt("a");
    pushPrompt("b");
    pushPrompt("c");
    pushPrompt("a");
    expect(useGlobalPromptHistoryStore.getState().entries).toEqual(["b", "c", "a"]);
  });

  it("treats a repeat of the most recent entry as a no-op (still moved to end)", () => {
    const { pushPrompt } = useGlobalPromptHistoryStore.getState();
    pushPrompt("hello");
    pushPrompt("hello");
    expect(useGlobalPromptHistoryStore.getState().entries).toEqual(["hello"]);
  });

  it("caps the list at PROMPT_HISTORY_MAX_ENTRIES, dropping the oldest", () => {
    const { pushPrompt } = useGlobalPromptHistoryStore.getState();
    for (let i = 0; i < PROMPT_HISTORY_MAX_ENTRIES + 5; i += 1) {
      pushPrompt(`prompt-${i}`);
    }
    const entries = useGlobalPromptHistoryStore.getState().entries;
    expect(entries).toHaveLength(PROMPT_HISTORY_MAX_ENTRIES);
    // Oldest 5 should have been dropped; newest is "prompt-204".
    expect(entries[0]).toBe("prompt-5");
    expect(entries.at(-1)).toBe(`prompt-${PROMPT_HISTORY_MAX_ENTRIES + 4}`);
  });

  it("clear() empties the store", () => {
    const { pushPrompt, clear } = useGlobalPromptHistoryStore.getState();
    pushPrompt("a");
    pushPrompt("b");
    clear();
    expect(useGlobalPromptHistoryStore.getState().entries).toEqual([]);
  });

  it("partialize only keeps the entries array", () => {
    useGlobalPromptHistoryStore.setState({ entries: ["x", "y"] });
    const partialize = useGlobalPromptHistoryStore.persist.getOptions().partialize;
    expect(partialize?.(useGlobalPromptHistoryStore.getState())).toEqual({ entries: ["x", "y"] });
  });

  it("merge sanitizes persisted state on rehydrate", () => {
    const merge = useGlobalPromptHistoryStore.persist.getOptions().merge;
    const merged = merge?.(
      // includes empty, dup, non-string entries
      { entries: ["a", "  b  ", "", "a", 42, "c"] } as unknown,
      useGlobalPromptHistoryStore.getState(),
    );
    expect(merged?.entries).toEqual(["a", "b", "c"]);
  });

  it("merge returns empty entries when persisted state is missing or invalid", () => {
    const merge = useGlobalPromptHistoryStore.persist.getOptions().merge;
    expect(merge?.(undefined, useGlobalPromptHistoryStore.getState())?.entries).toEqual([]);
    expect(
      merge?.({ entries: "not-an-array" } as unknown, useGlobalPromptHistoryStore.getState())
        ?.entries,
    ).toEqual([]);
  });
});
