/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (theme: Record<string, unknown>) => unknown)({
            spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
            colors: {
              foregroundMuted: "#aaa",
              palette: { amber: { 500: "#f0b429", 700: "#b7791f" } },
            },
          })
        : factory,
  },
  useUnistyles: () => ({ rt: { breakpoint: "md" } }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("@/components/message", () => ({
  AssistantTurnFooter: () => null,
  LiveElapsed: () => <span data-testid="running-turn-timestamp" />,
  STREAM_METADATA_FONT_SIZE: 11,
}));

vi.mock("@/components/assistant-fork-menu", () => ({
  AssistantForkMenu: () => <button data-testid="running-turn-fork" type="button" />,
}));

vi.mock("@/components/synced-loader", () => ({
  SyncedLoader: () => <span data-testid="running-turn-loader" />,
}));

vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => true,
}));

import { TurnFooter } from "./turn-footer";

const unusedRunningTurnStrategy = null as unknown as React.ComponentProps<
  typeof TurnFooter
>["strategy"];

describe("TurnFooter", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("places the running-turn fork between the loader and timestamp", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <TurnFooter
          isRunning
          inFlightTurnStartedAt={new Date("2026-08-01T10:00:00.000Z")}
          host={null}
          strategy={unusedRunningTurnStrategy}
          supportsTimelineCursor
          onForkInFlightTurn={vi.fn()}
        />,
      );
    });

    const footer = container.querySelector('[data-testid="turn-working-indicator"]');
    const controls = Array.from(footer?.querySelectorAll("[data-testid]") ?? []).map((node) =>
      node.getAttribute("data-testid"),
    );

    expect(controls).toEqual([
      "running-turn-loader",
      "running-turn-fork",
      "running-turn-timestamp",
    ]);
  });
});
