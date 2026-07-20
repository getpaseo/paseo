// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { useTimelineSearchUiStore } from "@/stores/timeline-search-ui-store";
import { useTimelineSearchModel } from "./use-timeline-search-model";

beforeEach(() => {
  useTimelineSearchUiStore.setState({ snapshotByKey: {} });
});

function makeUserMessage(text: string, id: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date("2024-01-01") };
}

describe("useTimelineSearchModel", () => {
  it("starts closed with empty query and no matches", () => {
    const getNoItems = () => [];
    const { result } = renderHook(() => useTimelineSearchModel(getNoItems));
    expect(result.current.state.isOpen).toBe(false);
    expect(result.current.state.query).toBe("");
    expect(result.current.state.matches).toHaveLength(0);
  });

  it("re-renders when the model notifies of a state change", () => {
    let items: StreamItem[] = [makeUserMessage("hello world", "u1")];
    const getItems = () => items;
    const { result } = renderHook(() => useTimelineSearchModel(getItems));

    act(() => {
      result.current.model.setQuery("hello");
    });

    expect(result.current.state.query).toBe("hello");
    expect(result.current.state.matches).toHaveLength(1);
  });

  it("reads the latest items via the ref without recreating the model", () => {
    let items: StreamItem[] = [makeUserMessage("hello world", "u1")];
    const { result, rerender } = renderHook(({ getItems }) => useTimelineSearchModel(getItems), {
      initialProps: { getItems: () => items },
    });
    const firstModel = result.current.model;

    act(() => {
      result.current.model.setQuery("newitem");
    });
    expect(result.current.state.matches).toHaveLength(0);

    items = [...items, makeUserMessage("this is a newitem added live", "u2")];
    rerender({ getItems: () => items });

    act(() => {
      result.current.model.refresh();
    });

    expect(result.current.model).toBe(firstModel);
    expect(result.current.state.matches.length).toBeGreaterThan(0);
  });

  it("keeps search state across unrelated re-renders", () => {
    const items: StreamItem[] = [makeUserMessage("hello world", "u1")];
    const { result, rerender } = renderHook(({ getItems }) => useTimelineSearchModel(getItems), {
      initialProps: { getItems: () => items },
    });

    act(() => {
      result.current.model.setQuery("hello");
      result.current.model.open();
    });

    rerender({ getItems: () => items });

    expect(result.current.state.query).toBe("hello");
    expect(result.current.state.isOpen).toBe(true);
  });

  it("keeps search state across re-renders that pass the same resetKey", () => {
    const items: StreamItem[] = [makeUserMessage("hello world", "u1")];
    const { result, rerender } = renderHook(
      ({ getItems, resetKey }) => useTimelineSearchModel(getItems, resetKey),
      { initialProps: { getItems: () => items, resetKey: "agent-1" } },
    );
    const firstModel = result.current.model;

    act(() => {
      result.current.model.setQuery("hello");
      result.current.model.open();
    });

    rerender({ getItems: () => items, resetKey: "agent-1" });

    expect(result.current.model).toBe(firstModel);
    expect(result.current.state.query).toBe("hello");
    expect(result.current.state.isOpen).toBe(true);
  });

  it("recreates the model with fresh state when resetKey changes", () => {
    const items: StreamItem[] = [makeUserMessage("hello world", "u1")];
    const { result, rerender } = renderHook(
      ({ getItems, resetKey }) => useTimelineSearchModel(getItems, resetKey),
      { initialProps: { getItems: () => items, resetKey: "agent-1" } },
    );
    const firstModel = result.current.model;

    act(() => {
      result.current.model.setQuery("hello");
      result.current.model.open();
    });
    expect(result.current.state.isOpen).toBe(true);
    expect(result.current.state.query).toBe("hello");

    // Retargeting the tab to a different agent must not leak the previous
    // agent's open search panel, query, or matches into the new one.
    rerender({ getItems: () => items, resetKey: "agent-2" });

    expect(result.current.model).not.toBe(firstModel);
    expect(result.current.state.isOpen).toBe(false);
    expect(result.current.state.query).toBe("");
    expect(result.current.state.matches).toHaveLength(0);
  });

  it("restores isOpen/query/filter for the same resetKey after a remount", () => {
    const items: StreamItem[] = [makeUserMessage("hello world", "u1")];
    const getItems = () => items;

    const first = renderHook(({ resetKey }) => useTimelineSearchModel(getItems, resetKey), {
      initialProps: { resetKey: "agent-remount" },
    });

    act(() => {
      first.result.current.model.setFilter("prompts");
      first.result.current.model.setQuery("hello");
      first.result.current.model.open();
    });
    expect(first.result.current.state.isOpen).toBe(true);

    // Simulate a full component unmount + remount for the SAME agent, e.g. a
    // compact/desktop breakpoint flip remounting AgentStreamView.
    first.unmount();

    const second = renderHook(({ resetKey }) => useTimelineSearchModel(getItems, resetKey), {
      initialProps: { resetKey: "agent-remount" },
    });

    expect(second.result.current.state.isOpen).toBe(true);
    expect(second.result.current.state.query).toBe("hello");
    expect(second.result.current.state.filter).toBe("prompts");
    expect(second.result.current.state.matches).toHaveLength(1);
  });

  it("does not leak stored search state into a different resetKey", () => {
    const items: StreamItem[] = [makeUserMessage("hello world", "u1")];
    const getItems = () => items;

    const first = renderHook(({ resetKey }) => useTimelineSearchModel(getItems, resetKey), {
      initialProps: { resetKey: "agent-a" },
    });

    act(() => {
      first.result.current.model.setQuery("hello");
      first.result.current.model.open();
    });
    first.unmount();

    const second = renderHook(({ resetKey }) => useTimelineSearchModel(getItems, resetKey), {
      initialProps: { resetKey: "agent-b" },
    });

    expect(second.result.current.state.isOpen).toBe(false);
    expect(second.result.current.state.query).toBe("");
  });
});
