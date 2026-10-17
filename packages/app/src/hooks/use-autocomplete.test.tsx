/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAutocomplete } from "./use-autocomplete";

describe("autocomplete acceptance while loading", () => {
  it.each(["Enter", "Tab"])("consumes %s until the current results are ready", (key) => {
    const onSelectOption = vi.fn();
    const preventDefault = vi.fn();
    const { result, rerender } = renderHook(
      ({ isLoading, options }) =>
        useAutocomplete({ isVisible: true, isLoading, options, query: "READ", onSelectOption }),
      { initialProps: { isLoading: true, options: [] as string[] } },
    );

    expect(result.current.onKeyPress({ key, preventDefault })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onSelectOption).not.toHaveBeenCalled();

    rerender({ isLoading: true, options: ["stale.md"] });
    expect(result.current.onKeyPress({ key, preventDefault })).toBe(true);
    expect(onSelectOption).not.toHaveBeenCalled();

    rerender({ isLoading: false, options: ["README.md"] });
    expect(result.current.onKeyPress({ key, preventDefault })).toBe(true);
    expect(onSelectOption).toHaveBeenCalledWith("README.md", { key, preventDefault });

    rerender({ isLoading: false, options: [] });
    expect(result.current.onKeyPress({ key, preventDefault })).toBe(false);
  });

  it("does not capture keys for a hidden lookup", () => {
    const preventDefault = vi.fn();
    const { result } = renderHook(() =>
      useAutocomplete({
        isVisible: false,
        isLoading: true,
        options: [],
        query: "READ",
        onSelectOption: vi.fn(),
      }),
    );
    expect(result.current.onKeyPress({ key: "Enter", preventDefault })).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
