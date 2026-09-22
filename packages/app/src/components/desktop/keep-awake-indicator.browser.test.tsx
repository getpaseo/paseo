import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeepAwakeIndicator } from "@/components/desktop/keep-awake-indicator";
// Importing the shared instance initializes i18next, so the indicator's copy resolves.
import { i18n } from "@/i18n/i18next";
import { useSessionStore, type SleepPreventionState } from "@/stores/session-store";

void i18n;

let mounted: { root: Root; container: HTMLDivElement } | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

function seedSleepPrevention(state: SleepPreventionState | null): void {
  useSessionStore.setState({
    sessions: {
      "host-1": { sleepPrevention: state },
    },
  } as unknown as Parameters<typeof useSessionStore.setState>[0]);
}

function render(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  act(() => root.render(<KeepAwakeIndicator />));
  return container;
}

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  useSessionStore.setState({ sessions: {} } as unknown as Parameters<
    typeof useSessionStore.setState
  >[0]);
  vi.unstubAllGlobals();
});

describe("keep-awake indicator", () => {
  it("stays out of the way when nothing is being held awake", () => {
    seedSleepPrevention({ active: false, supported: true, agentCount: 0 });

    const container = render();

    expect(container.querySelector('[data-testid="keep-awake-indicator"]')).toBeNull();
  });

  it("says how many agents have active sleep prevention", () => {
    seedSleepPrevention({ active: true, supported: true, agentCount: 2 });

    const container = render();
    const indicator = container.querySelector('[data-testid="keep-awake-indicator"]');

    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("aria-label")).toBe("Sleep prevention active for 2 agents");
  });

  it("uses the singular when one agent is holding it", () => {
    seedSleepPrevention({ active: true, supported: true, agentCount: 1 });

    const container = render();

    expect(
      container.querySelector('[data-testid="keep-awake-indicator"]')?.getAttribute("aria-label"),
    ).toBe("Sleep prevention active for 1 agent");
  });

  it("disappears once the daemon releases the inhibitor", () => {
    seedSleepPrevention({ active: true, supported: true, agentCount: 1 });
    const container = render();
    expect(container.querySelector('[data-testid="keep-awake-indicator"]')).not.toBeNull();

    act(() => seedSleepPrevention({ active: true, supported: true, agentCount: 0 }));
    expect(
      container.querySelector('[data-testid="keep-awake-indicator"]')?.getAttribute("aria-label"),
    ).toBe("Sleep prevention active");

    act(() => seedSleepPrevention({ active: false, supported: true, agentCount: 0 }));

    expect(container.querySelector('[data-testid="keep-awake-indicator"]')).toBeNull();
  });
});
