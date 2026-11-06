// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAutocomplete } from "./use-autocomplete";

const ALL = ["exit", "review", "compact"];
const FILTERED = ["compact"];

function press(
  onKeyPress: (event: { key: string; preventDefault: () => void }) => boolean,
  key: string,
) {
  act(() => {
    onKeyPress({ key, preventDefault: () => {} });
  });
}

describe("useAutocomplete", () => {
  it("drops a choice once the query changes, even when the query comes back", () => {
    const picked: string[] = [];
    const { result, rerender } = renderHook(
      ({ query, options }: { query: string; options: string[] }) =>
        useAutocomplete({
          isVisible: true,
          options,
          query,
          onSelectOption: (option) => picked.push(option),
        }),
      { initialProps: { query: "", options: ALL } },
    );

    expect(result.current.selectedIndex).toBe(2);
    press(result.current.onKeyPress, "ArrowUp");
    press(result.current.onKeyPress, "ArrowUp");
    expect(result.current.selectedIndex).toBe(0);

    rerender({ query: "com", options: FILTERED });
    expect(result.current.selectedIndex).toBe(0);
    rerender({ query: "", options: ALL });

    expect(result.current.selectedIndex).toBe(2);
    press(result.current.onKeyPress, "Enter");
    expect(picked).toEqual(["compact"]);
  });
});
