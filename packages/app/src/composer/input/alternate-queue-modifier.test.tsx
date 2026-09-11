/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAlternateQueueModifier } from "./input";

interface ModifierHookProps {
  defaultSendBehavior: "interrupt" | "steer" | "queue";
}

describe("useAlternateQueueModifier", () => {
  it("shows Queue while Cmd/Ctrl is held for a running agent", () => {
    const { result, rerender } = renderHook<boolean, ModifierHookProps>(
      ({ defaultSendBehavior }) =>
        useAlternateQueueModifier({
          isAgentRunning: true,
          defaultSendBehavior,
          onQueue: vi.fn(),
        }),
      { initialProps: { defaultSendBehavior: "steer" } },
    );

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" })));
    expect(result.current).toBe(true);

    act(() => window.dispatchEvent(new KeyboardEvent("keyup")));
    expect(result.current).toBe(false);

    rerender({ defaultSendBehavior: "queue" });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true })));
    expect(result.current).toBe(false);
  });
});
