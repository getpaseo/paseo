// @vitest-environment jsdom
import "@/test/window-local-storage";
import { i18n as testI18n } from "@/i18n/i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAgentAutocomplete } from "./use-agent-autocomplete";

void testI18n;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// Regression for the escape-dismiss fix. Escape dismisses the autocomplete popover
// (the composer registers `dismiss` with the shared escape-dismiss stack) WITHOUT
// clearing the input, and typing re-opens it. The removed `onEscape` used to clear
// a start-position slash command on Escape; that path is intentionally gone.
describe("useAgentAutocomplete dismiss", () => {
  it("hides the popover on dismiss without touching the input, then re-opens on new input", () => {
    const setUserInput = vi.fn();
    const { result, rerender } = renderHook(
      (props: { userInput: string }) =>
        useAgentAutocomplete({
          userInput: props.userInput,
          cursorIndex: props.userInput.length,
          setUserInput,
          serverId: "s1",
          agentId: "a1",
          draftConfig: { provider: "claude", cwd: "/tmp" },
        }),
      { wrapper: Wrapper, initialProps: { userInput: "@src/foo" } },
    );

    // A file mention is active, so the popover is visible.
    expect(result.current.isVisible).toBe(true);

    // dismiss() is what Escape triggers via the shared stack: hide the popover,
    // and crucially do NOT rewrite the input text.
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.isVisible).toBe(false);
    expect(setUserInput).not.toHaveBeenCalled();

    // Typing more changes the active mention target, which re-opens the popover.
    rerender({ userInput: "@src/food" });
    expect(result.current.isVisible).toBe(true);
  });
});
