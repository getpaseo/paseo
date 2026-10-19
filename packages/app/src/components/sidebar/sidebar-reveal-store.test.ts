import { beforeEach, describe, expect, it } from "vitest";
import { createRef } from "react";
import type { View } from "react-native";
import {
  getRevealRowRef,
  registerRevealRow,
  requestSidebarWorkspaceReveal,
  useSidebarRevealStore,
} from "./sidebar-reveal-store";
import { usePanelStore } from "@/stores/panel-store";

describe("sidebar reveal store", () => {
  beforeEach(() => {
    useSidebarRevealStore.setState({ request: null, flash: null });
    usePanelStore.setState({
      mobilePanel: { target: "agent", revision: 0 },
      desktop: { agentListOpen: false, focusModeEnabled: false },
    });
  });

  it("stores a reveal request keyed by the workspace identity", () => {
    useSidebarRevealStore.getState().requestReveal({ serverId: "local", workspaceId: "ws-1" });

    const request = useSidebarRevealStore.getState().request;
    expect(request?.workspaceKey).toBe("local:ws-1");
    expect(request?.token).toBeGreaterThan(0);
  });

  it("ignores requests without a resolvable workspace identity", () => {
    useSidebarRevealStore.getState().requestReveal({ serverId: "  ", workspaceId: "ws-1" });

    expect(useSidebarRevealStore.getState().request).toBeNull();
  });

  it("retriggers with a fresh token for a repeated reveal", () => {
    useSidebarRevealStore.getState().requestReveal({ serverId: "local", workspaceId: "ws-1" });
    const first = useSidebarRevealStore.getState().request;

    useSidebarRevealStore.getState().requestReveal({ serverId: "local", workspaceId: "ws-1" });
    const second = useSidebarRevealStore.getState().request;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.token).toBeGreaterThan(first?.token ?? 0);
    expect(useSidebarRevealStore.getState().flash).toBeNull();
  });

  it("consumeRequest only clears the request it belongs to", () => {
    useSidebarRevealStore.getState().requestReveal({ serverId: "local", workspaceId: "ws-1" });
    const staleToken = useSidebarRevealStore.getState().request?.token ?? 0;

    useSidebarRevealStore.getState().requestReveal({ serverId: "local", workspaceId: "ws-2" });
    useSidebarRevealStore.getState().consumeRequest(staleToken);
    expect(useSidebarRevealStore.getState().request?.workspaceKey).toBe("local:ws-2");

    const currentToken = useSidebarRevealStore.getState().request?.token ?? 0;
    useSidebarRevealStore.getState().consumeRequest(currentToken);
    expect(useSidebarRevealStore.getState().request).toBeNull();
  });

  it("runs one flash at a time and clears it on completion", () => {
    useSidebarRevealStore.getState().beginFlash({ workspaceKey: "local:ws-1", token: 7 });
    expect(useSidebarRevealStore.getState().flash).toEqual({
      workspaceKey: "local:ws-1",
      token: 7,
    });

    useSidebarRevealStore.getState().completeFlash(6);
    expect(useSidebarRevealStore.getState().flash).not.toBeNull();

    useSidebarRevealStore.getState().completeFlash(7);
    expect(useSidebarRevealStore.getState().flash).toBeNull();
  });

  it("opens the agent list, then records the request", () => {
    requestSidebarWorkspaceReveal({ serverId: "local", workspaceId: "ws-1" });

    expect(usePanelStore.getState().desktop.agentListOpen).toBe(true);
    expect(useSidebarRevealStore.getState().request?.workspaceKey).toBe("local:ws-1");
  });
});

describe("reveal row registry", () => {
  it("hands back the registered ref and stops on unregister", () => {
    const ref = createRef<View | null>();
    ref.current = null;

    const unregister = registerRevealRow({ workspaceKey: "local:ws-1", ref });
    expect(getRevealRowRef("local:ws-1")).toBe(ref);

    unregister();
    expect(getRevealRowRef("local:ws-1")).toBeNull();
  });

  it("keeps the newest registration when a row re-registers", () => {
    const first = createRef<View | null>();
    const second = createRef<View | null>();

    const unregisterFirst = registerRevealRow({ workspaceKey: "local:ws-1", ref: first });
    const unregisterSecond = registerRevealRow({ workspaceKey: "local:ws-1", ref: second });
    expect(getRevealRowRef("local:ws-1")).toBe(second);

    // The unmounted stale row must not evict the live one.
    unregisterFirst();
    expect(getRevealRowRef("local:ws-1")).toBe(second);

    unregisterSecond();
    expect(getRevealRowRef("local:ws-1")).toBeNull();
  });
});
