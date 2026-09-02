/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveLiveActivityFocusTarget,
  useLiveActivityFocusStore,
  useLiveActivityPermissionFocus,
} from "./live-activity-focus";

afterEach(() => {
  useLiveActivityFocusStore.setState({ focus: null });
});

describe("resolveLiveActivityFocusTarget", () => {
  it("returns the exact request and action for a Live Activity route", () => {
    expect(
      resolveLiveActivityFocusTarget({
        source: "live-activity",
        serverId: "server-1",
        agentId: "agent-1",
        permissionRequestId: "req-1",
        permissionActionId: "accept",
      }),
    ).toEqual({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
      actionId: "accept",
    });
  });

  it("ignores ordinary agent routes and Live Activity routes without a request", () => {
    const base = {
      serverId: "server-1",
      agentId: "agent-1",
      permissionActionId: undefined,
    };
    expect(
      resolveLiveActivityFocusTarget({
        ...base,
        source: "notification",
        permissionRequestId: "req-1",
      }),
    ).toBeNull();
    expect(
      resolveLiveActivityFocusTarget({
        ...base,
        source: "live-activity",
        permissionRequestId: "",
      }),
    ).toBeNull();
  });
});

describe("useLiveActivityPermissionFocus", () => {
  it("is unfocused before any target is recorded", () => {
    const { result } = renderHook(() => useLiveActivityPermissionFocus("agent-1", "req-1"));
    expect(result.current).toEqual({ isFocused: false, focusedActionId: undefined });
  });

  it("matches by agentId and requestId, exposing the recorded actionId", () => {
    useLiveActivityFocusStore.getState().setFocus({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
      actionId: "accept",
    });
    const { result } = renderHook(() => useLiveActivityPermissionFocus("agent-1", "req-1"));
    expect(result.current).toEqual({ isFocused: true, focusedActionId: "accept" });
  });

  it("does not match a different agentId even with the same requestId", () => {
    useLiveActivityFocusStore.getState().setFocus({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
    const { result } = renderHook(() => useLiveActivityPermissionFocus("agent-2", "req-1"));
    expect(result.current).toEqual({ isFocused: false, focusedActionId: undefined });
  });

  it("does not match a different requestId even with the same agentId", () => {
    useLiveActivityFocusStore.getState().setFocus({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
    const { result } = renderHook(() => useLiveActivityPermissionFocus("agent-1", "req-2"));
    expect(result.current).toEqual({ isFocused: false, focusedActionId: undefined });
  });

  it("exposes no focusedActionId when the recorded target has no actionId", () => {
    useLiveActivityFocusStore.getState().setFocus({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
    const { result } = renderHook(() => useLiveActivityPermissionFocus("agent-1", "req-1"));
    expect(result.current).toEqual({ isFocused: true, focusedActionId: undefined });
  });
});

describe("useLiveActivityFocusStore clearFocus", () => {
  it("clears the focus when the match agrees with the recorded target", () => {
    useLiveActivityFocusStore.getState().setFocus({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
    useLiveActivityFocusStore.getState().clearFocus({ agentId: "agent-1", requestId: "req-1" });
    expect(useLiveActivityFocusStore.getState().focus).toBeNull();
  });

  it("leaves an unrelated focus target untouched", () => {
    useLiveActivityFocusStore.getState().setFocus({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
    useLiveActivityFocusStore.getState().clearFocus({ agentId: "agent-2", requestId: "req-1" });
    expect(useLiveActivityFocusStore.getState().focus).toEqual({
      serverId: "server-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
  });

  it("is a no-op when nothing is focused", () => {
    useLiveActivityFocusStore.getState().clearFocus({ agentId: "agent-1", requestId: "req-1" });
    expect(useLiveActivityFocusStore.getState().focus).toBeNull();
  });
});
