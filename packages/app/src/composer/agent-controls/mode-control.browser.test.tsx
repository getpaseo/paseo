import React, { useMemo } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { ComposerKeyboardScopeProvider } from "@/composer/keyboard-scope";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { useAgentModeCycleShortcut, type AgentModeControlValue } from "./mode-control";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(cleanup);

const MODES: AgentMode[] = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
  { id: "bypass", label: "Bypass" },
];

let dispatcher: ReturnType<typeof useKeyboardActionDispatcher> | null = null;

// A composer's controls with no Mode control mounted, as a compact composer renders them while
// its settings drawer is closed.
function ComposerControlsProbe({
  selectedModeId,
  onSelectMode,
}: {
  selectedModeId: string;
  onSelectMode: (modeId: string) => void;
}) {
  dispatcher = useKeyboardActionDispatcher();
  const modeControl = useMemo<AgentModeControlValue>(
    () => ({
      provider: "claude",
      providerDefinitions: [],
      modeOptions: MODES,
      selectedModeId,
      onSelectMode,
    }),
    [onSelectMode, selectedModeId],
  );
  useAgentModeCycleShortcut(modeControl);
  return null;
}

function renderComposer(input: { selectedModeId: string; isActiveComposer?: boolean }) {
  const onSelectMode = vi.fn();
  render(
    <KeyboardActionDispatcherProvider>
      <ComposerKeyboardScopeProvider
        isPaneFocused
        isActiveComposer={input.isActiveComposer ?? true}
        isCommandCenterTarget
      >
        <ComposerControlsProbe selectedModeId={input.selectedModeId} onSelectMode={onSelectMode} />
      </ComposerKeyboardScopeProvider>
    </KeyboardActionDispatcherProvider>,
  );
  return onSelectMode;
}

function cycleMode(): boolean {
  if (!dispatcher) throw new Error("The dispatcher is not mounted");
  let handled = false;
  act(() => {
    handled = dispatcher!.dispatch({ id: "message-input.mode-cycle", scope: "message-input" });
  });
  return handled;
}

describe("useAgentModeCycleShortcut", () => {
  it("cycles to the next mode without a Mode control on screen", () => {
    const onSelectMode = renderComposer({ selectedModeId: "plan" });
    expect(cycleMode()).toBe(true);
    expect(onSelectMode).toHaveBeenCalledWith("bypass");
  });

  it("leaves the shortcut to the composer that takes input", () => {
    const onSelectMode = renderComposer({ selectedModeId: "plan", isActiveComposer: false });
    expect(cycleMode()).toBe(false);
    expect(onSelectMode).not.toHaveBeenCalled();
  });
});
