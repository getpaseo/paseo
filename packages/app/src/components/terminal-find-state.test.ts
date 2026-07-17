import { describe, expect, it } from "vitest";
import { INITIAL_TERMINAL_FIND_STATE, reduceTerminalFindState } from "./terminal-find-state";

describe("terminal find state", () => {
  it("clears stale result selection while a new terminal query is pending", () => {
    const previous = {
      ...INITIAL_TERMINAL_FIND_STATE,
      isOpen: true,
      query: "old",
      matchCount: 3,
      selectedIndex: 2,
    };

    expect(reduceTerminalFindState(previous, { type: "query", query: "new" })).toEqual({
      isOpen: true,
      query: "new",
      isPending: true,
      matchCount: 0,
      selectedIndex: -1,
    });
  });

  it("only presents the reported result after the active query resolves", () => {
    const pending = reduceTerminalFindState(INITIAL_TERMINAL_FIND_STATE, {
      type: "query",
      query: "result",
    });

    expect(
      reduceTerminalFindState(pending, { type: "result", matchCount: 2, selectedIndex: 1 }),
    ).toEqual({
      isOpen: false,
      query: "result",
      isPending: false,
      matchCount: 2,
      selectedIndex: 1,
    });
  });

  it("resets the query, highlights, and inline controls together when focus is lost", () => {
    expect(
      reduceTerminalFindState(
        {
          ...INITIAL_TERMINAL_FIND_STATE,
          isOpen: true,
          query: "result",
          matchCount: 1,
          selectedIndex: 0,
        },
        { type: "reset" },
      ),
    ).toEqual(INITIAL_TERMINAL_FIND_STATE);
  });
});
