// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createTimelineSearchModel, type TimelineSearchState } from "./timeline-search-model";
import { TimelineSearchPanel } from "./timeline-search-panel";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    fontSize: { xs: 11, sm: 13 },
    borderRadius: { sm: 2, md: 6, full: 9999 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    shadow: { md: {} },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface1: "#111",
      surface2: "#222",
      border: "#444",
      accent: "#0a84ff",
      accentForeground: "#fff",
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
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === "timelineSearch.matchCount") {
        return `${options?.count} matches`;
      }
      return key;
    },
  }),
}));

function makeUserMessage(text: string, id: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date("2024-01-01") };
}

function makeAssistantMessage(text: string, id: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date("2024-01-01") };
}

function makeThought(text: string, id: string): StreamItem {
  return { kind: "thought", id, text, timestamp: new Date("2024-01-01"), status: "ready" };
}

function renderPanel(items: StreamItem[], query = "world", { isPaging = false } = {}) {
  const model = createTimelineSearchModel(() => items);
  model.setFilter("all");
  model.setQuery(query);
  model.open();

  let state: TimelineSearchState = model.getState();
  const rerenderCallbacks: Array<() => void> = [];
  model.subscribe(() => {
    state = model.getState();
    rerenderCallbacks.forEach((cb) => cb());
  });

  const onClose = vi.fn();

  const { rerender } = render(
    <TimelineSearchPanel
      state={state}
      isPaging={isPaging}
      onQueryChange={model.setQuery}
      onFilterChange={model.setFilter}
      onSelectNext={model.selectNext}
      onSelectPrev={model.selectPrev}
      onSelectIndex={model.selectIndex}
      onClose={onClose}
      testID="panel"
    />,
  );

  rerenderCallbacks.push(() =>
    rerender(
      <TimelineSearchPanel
        state={model.getState()}
        isPaging={isPaging}
        onQueryChange={model.setQuery}
        onFilterChange={model.setFilter}
        onSelectNext={model.selectNext}
        onSelectPrev={model.selectPrev}
        onSelectIndex={model.selectIndex}
        onClose={onClose}
        testID="panel"
      />,
    ),
  );

  return { model, onClose };
}

describe("TimelineSearchPanel", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the match count and highlights the query in each match snippet", () => {
    renderPanel([
      makeUserMessage("hello world", "u1"),
      makeAssistantMessage("goodbye world", "a1"),
    ]);

    expect(screen.getByText("2 matches")).toBeTruthy();
    // The matched term is split into its own highlighted text node in each row,
    // so it appears once per match snippet.
    expect(screen.getAllByText("world")).toHaveLength(2);
    // The surrounding (non-highlighted) text is still rendered.
    expect(screen.getByText("hello", { exact: false })).toBeTruthy();
    expect(screen.getByText("goodbye", { exact: false })).toBeTruthy();
  });

  it("shows the no-results message when the query has no matches", () => {
    renderPanel([makeUserMessage("hello", "u1")], "zzznomatch");

    expect(screen.getByText("timelineSearch.noResults")).toBeTruthy();
    expect(screen.queryByText("hello")).toBeNull();
  });

  it("shows a searching-history pending state instead of no-results while paging older history", () => {
    renderPanel([makeUserMessage("hello", "u1")], "zzznomatch", { isPaging: true });

    // While older history is still loading, the panel must not claim there are no
    // results — it shows the pending status and the loading-older-history note.
    expect(screen.getByText("timelineSearch.searchingHistory")).toBeTruthy();
    expect(screen.queryByText("timelineSearch.noResults")).toBeNull();
    expect(screen.getByText("timelineSearch.loadingOlderHistory")).toBeTruthy();
  });

  it("calls onFilterChange when a filter chip is pressed", () => {
    const { model } = renderPanel([
      makeUserMessage("hello world", "u1"),
      makeAssistantMessage("goodbye world", "a1"),
    ]);

    fireEvent.click(screen.getByTestId("timeline-search-filter-messages"));
    expect(model.getState().filter).toBe("messages");
  });

  it("offers a thinking filter that isolates reasoning matches", () => {
    const { model } = renderPanel(
      [makeAssistantMessage("Visible response", "a1"), makeThought("Private reasoning", "t1")],
      "reasoning",
    );

    fireEvent.click(screen.getByTestId("timeline-search-filter-thinking"));
    expect(model.getState().filter).toBe("thinking");
    expect(model.getState().matches).toHaveLength(1);
    expect(model.getState().matches[0]?.item.id).toBe("t1");
  });

  it("calls onSelectNext/onSelectPrev from the nav buttons", () => {
    const { model } = renderPanel([
      makeUserMessage("hello world", "u1"),
      makeAssistantMessage("goodbye world", "a1"),
    ]);

    expect(model.getState().selectedIndex).toBe(0);
    fireEvent.click(screen.getByTestId("timeline-search-next"));
    expect(model.getState().selectedIndex).toBe(1);
    fireEvent.click(screen.getByTestId("timeline-search-prev"));
    expect(model.getState().selectedIndex).toBe(0);
  });

  it("calls onSelectIndex when a match row is pressed", () => {
    const { model } = renderPanel([
      makeUserMessage("hello world", "u1"),
      makeAssistantMessage("goodbye world", "a1"),
    ]);

    // The snippet is split for highlighting; the non-highlighted prefix is
    // unique to the second row's Pressable.
    fireEvent.click(screen.getByText("goodbye", { exact: false }));
    expect(model.getState().selectedIndex).toBe(1);
  });

  it("navigates to the next match on Enter", () => {
    const { model } = renderPanel([
      makeUserMessage("hello world", "u1"),
      makeAssistantMessage("goodbye world", "a1"),
    ]);
    expect(model.getState().selectedIndex).toBe(0);
    fireEvent.keyDown(screen.getByTestId("timeline-search-input"), { key: "Enter" });
    expect(model.getState().selectedIndex).toBe(1);
  });

  it("navigates to the previous match on Shift+Enter", () => {
    const { model } = renderPanel([
      makeUserMessage("hello world", "u1"),
      makeAssistantMessage("goodbye world", "a1"),
    ]);
    expect(model.getState().selectedIndex).toBe(0);
    // Shift+Enter from the first match wraps back to the last.
    fireEvent.keyDown(screen.getByTestId("timeline-search-input"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(model.getState().selectedIndex).toBe(1);
  });

  it("closes on Escape from the input", () => {
    const { onClose } = renderPanel([makeUserMessage("hello world", "u1")]);
    fireEvent.keyDown(screen.getByTestId("timeline-search-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is pressed", () => {
    const { onClose } = renderPanel([makeUserMessage("hello world", "u1")]);
    fireEvent.click(screen.getByTestId("timeline-search-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("debounces query changes while the user types", () => {
    vi.useFakeTimers();
    const { model } = renderPanel([makeUserMessage("hello world", "u1")], "");
    const input = screen.getByTestId("timeline-search-input");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(model.getState().query).toBe("");
    act(() => vi.advanceTimersByTime(150));
    expect(model.getState().query).toBe("hello");
  });

  it("flushes a pending query before navigation", () => {
    vi.useFakeTimers();
    const { model } = renderPanel([makeUserMessage("hello world", "u1")], "");
    fireEvent.change(screen.getByTestId("timeline-search-input"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByTestId("timeline-search-next"));
    expect(model.getState().query).toBe("hello");
    expect(model.getState().selectedIndex).toBe(0);
  });

  it("flushes a pending query before changing filters", () => {
    vi.useFakeTimers();
    const { model } = renderPanel([makeAssistantMessage("goodbye world", "a1")], "");
    fireEvent.change(screen.getByTestId("timeline-search-input"), {
      target: { value: "goodbye" },
    });
    fireEvent.click(screen.getByTestId("timeline-search-filter-messages"));
    expect(model.getState().query).toBe("goodbye");
    expect(model.getState().filter).toBe("messages");
    expect(model.getState().matches).toHaveLength(1);
  });

  it("cancels a pending draft when the query changes externally", () => {
    vi.useFakeTimers();
    const { model } = renderPanel([makeUserMessage("hello external", "u1")], "");
    fireEvent.change(screen.getByTestId("timeline-search-input"), {
      target: { value: "hello" },
    });
    act(() => model.setQuery("external"));
    act(() => vi.advanceTimersByTime(150));
    expect(model.getState().query).toBe("external");
  });

  it("closes on Escape and does not close on other keys", () => {
    const { onClose } = renderPanel([makeUserMessage("hello world", "u1")]);
    const input = screen.getByTestId("timeline-search-input");
    fireEvent.keyDown(input, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
