// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneFindBarView } from "./pane-find-bar";
import type { PaneFindState } from "./pane-find-types";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    fontSize: { xs: 11, sm: 13 },
    borderRadius: { sm: 2, full: 9999 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface1: "#111",
      border: "#444",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (
      Component: React.ComponentType<Record<string, unknown>>,
      mapTheme?: (theme: unknown) => Record<string, unknown>,
    ) =>
    (props: Record<string, unknown>) =>
      React.createElement(Component, { ...props, ...(mapTheme ? mapTheme(theme) : {}) }),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = (props: Record<string, unknown>) =>
      React.createElement("span", { "data-icon": name, "data-color": props.color });
    Icon.displayName = name;
    return Icon;
  };
  return {
    Search: icon("Search"),
    X: icon("X"),
    ChevronUp: icon("ChevronUp"),
    ChevronDown: icon("ChevronDown"),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const BASE_STATE: PaneFindState = {
  isOpen: true,
  query: "needle",
  isPending: false,
  matchCount: 3,
  selectedIndex: 0,
};

function makeState(overrides?: Partial<PaneFindState>): PaneFindState {
  return { ...BASE_STATE, ...overrides };
}

function renderBar(overrides?: Partial<PaneFindState>) {
  const handlers = {
    onQueryChange: vi.fn(),
    onSelectNext: vi.fn(),
    onSelectPrev: vi.fn(),
    onClose: vi.fn(),
  };
  const state = makeState(overrides);
  render(<PaneFindBarView state={state} testID="bar" {...handlers} />);
  return handlers;
}

describe("PaneFindBarView", () => {
  afterEach(() => {
    cleanup();
  });

  it("navigates forward on Enter", () => {
    const handlers = renderBar();
    fireEvent.keyDown(screen.getByTestId("pane-find-input"), { key: "Enter" });
    expect(handlers.onSelectNext).toHaveBeenCalledTimes(1);
    expect(handlers.onSelectPrev).not.toHaveBeenCalled();
  });

  it("navigates backward on Shift+Enter", () => {
    const handlers = renderBar();
    fireEvent.keyDown(screen.getByTestId("pane-find-input"), { key: "Enter", shiftKey: true });
    expect(handlers.onSelectPrev).toHaveBeenCalledTimes(1);
    expect(handlers.onSelectNext).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const handlers = renderBar();
    fireEvent.keyDown(screen.getByTestId("pane-find-input"), { key: "Escape" });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("trims queries before forwarding them to the adapter", () => {
    const handlers = renderBar();

    fireEvent.change(screen.getByTestId("pane-find-input"), {
      target: { value: "  needle  " },
    });
    expect(handlers.onQueryChange).toHaveBeenCalledWith("needle");

    fireEvent.change(screen.getByTestId("pane-find-input"), {
      target: { value: "   " },
    });
    expect(handlers.onQueryChange).toHaveBeenLastCalledWith("");
  });
});
