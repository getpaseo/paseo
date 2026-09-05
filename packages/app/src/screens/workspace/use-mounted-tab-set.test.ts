// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import {
  deriveMountableWorkspaceTabIds,
  shouldRetainInactiveAgentTimelines,
  useMountedTabSet,
} from "./use-mounted-tab-set";

function mountedIds(result: { current: ReturnType<typeof useMountedTabSet> }): string[] {
  return Array.from(result.current.mountedTabIds);
}

describe("useMountedTabSet", () => {
  it("includes a newly active tab in the same render", () => {
    let renderCount = 0;
    const { result, rerender } = renderHook(
      ({ activeTabId }) => {
        renderCount += 1;
        return useMountedTabSet({
          activeTabId,
          allTabIds: ["first", "second"],
          cap: 3,
        });
      },
      { initialProps: { activeTabId: "first" } },
    );

    expect(mountedIds(result)).toEqual(["first"]);
    expect(renderCount).toBe(1);

    rerender({ activeTabId: "second" });

    expect(mountedIds(result)).toEqual(["second", "first"]);
    expect(renderCount).toBe(2);
  });

  it("preserves the cap while synchronously adding the active tab", () => {
    const { result, rerender } = renderHook(
      ({ activeTabId }) =>
        useMountedTabSet({
          activeTabId,
          allTabIds: ["first", "second", "third"],
          cap: 2,
        }),
      { initialProps: { activeTabId: "first" } },
    );

    rerender({ activeTabId: "second" });
    expect(mountedIds(result)).toEqual(["second", "first"]);

    rerender({ activeTabId: "third" });
    expect(mountedIds(result)).toEqual(["third", "second"]);
  });

  it("keeps retained panels mounted beyond the normal cap", () => {
    const { result, rerender } = renderHook(
      ({ activeTabId }) =>
        useMountedTabSet({
          activeTabId,
          allTabIds: ["modified", "second", "third", "fourth"],
          retainedTabIds: new Set(["modified"]),
          cap: 2,
        }),
      { initialProps: { activeTabId: "modified" } },
    );

    rerender({ activeTabId: "second" });
    rerender({ activeTabId: "third" });
    rerender({ activeTabId: "fourth" });

    expect(mountedIds(result)).toEqual(["fourth", "modified"]);
  });
});

function tab(tabId: string, kind: WorkspaceTabDescriptor["kind"]): WorkspaceTabDescriptor {
  if (kind === "agent") {
    return { key: tabId, tabId, kind, target: { kind, agentId: tabId } };
  }
  if (kind === "provider_subagent") {
    return {
      key: tabId,
      tabId,
      kind,
      target: { kind, parentAgentId: "parent", subagentId: tabId },
    };
  }
  if (kind === "terminal") {
    return { key: tabId, tabId, kind, target: { kind, terminalId: tabId } };
  }
  throw new Error(`unsupported test tab kind: ${kind}`);
}

describe("deriveMountableWorkspaceTabIds", () => {
  const tabs = [
    tab("agent-a", "agent"),
    tab("child-a", "provider_subagent"),
    tab("term", "terminal"),
  ];

  it("keeps only the visible Agent timeline for the benchmark unmount variant", () => {
    expect(
      deriveMountableWorkspaceTabIds({
        activeTabId: "agent-a",
        isWorkspaceFocused: true,
        retainInactiveTimelineTabs: false,
        tabs,
      }),
    ).toEqual(["agent-a", "term"]);
  });

  it("keeps the production retained-panel lifecycle by default", () => {
    expect(
      deriveMountableWorkspaceTabIds({
        activeTabId: "agent-a",
        isWorkspaceFocused: true,
        retainInactiveTimelineTabs: true,
        tabs,
      }),
    ).toEqual(["agent-a", "child-a", "term"]);
  });
});

describe("inactive Agent timeline benchmark override", () => {
  it("defaults to retained and accepts explicit benchmark variants", () => {
    const testGlobal = globalThis as typeof globalThis & {
      __PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES?: unknown;
    };
    const previous = testGlobal.__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES;
    try {
      delete testGlobal.__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES;
      expect(shouldRetainInactiveAgentTimelines()).toBe(true);
      testGlobal.__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES = false;
      expect(shouldRetainInactiveAgentTimelines()).toBe(false);
      testGlobal.__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES = true;
      expect(shouldRetainInactiveAgentTimelines()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete testGlobal.__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES;
      } else {
        testGlobal.__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES = previous;
      }
    }
  });
});
