/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRuntimeBootstrapState } from "./_layout";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

const { redirectMock, state } = vi.hoisted(() => {
  const hoistedState = {
    pathname: "/",
    bootstrapState: {
      splashError: null,
      retry: vi.fn(),
      hasGivenUpWaitingForHost: false,
      storeReady: false,
    } as HostRuntimeBootstrapState,
    anyOnlineHostServerId: null as string | null,
    isWorkspaceSelectionLoaded: true,
    workspaceSelection: null as ActiveWorkspaceSelection | null,
  };

  return {
    redirectMock: vi.fn(),
    state: hoistedState,
  };
});

vi.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => {
    redirectMock(href);
    return React.createElement("div", { "data-testid": "redirect", "data-href": href });
  },
  usePathname: () => state.pathname,
}));

vi.mock("@/app/_layout", () => ({
  useHostRuntimeBootstrapState: () => state.bootstrapState,
  useEarliestOnlineHostServerId: () => state.anyOnlineHostServerId,
}));

vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  shouldUseDesktopDaemon: () => false,
}));

vi.mock("@/screens/startup-splash-screen", () => ({
  StartupSplashScreen: () => React.createElement("div", { "data-testid": "startup-splash" }),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  getLastNavigationWorkspaceRouteSelection: () => state.workspaceSelection,
  useIsLastNavigationWorkspaceRouteSelectionLoaded: () => state.isWorkspaceSelectionLoaded,
}));

describe("Index route startup navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetModules();
    state.pathname = "/";
    state.bootstrapState = {
      splashError: null,
      retry: vi.fn(),
      hasGivenUpWaitingForHost: false,
      storeReady: false,
    };
    state.anyOnlineHostServerId = null;
    state.isWorkspaceSelectionLoaded = true;
    state.workspaceSelection = null;
    redirectMock.mockReset();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderIndex() {
    const { default: Index } = await import("./index");
    await act(async () => {
      root.render(<Index />);
    });
  }

  it("shows the startup splash while no host is online and the welcome timer has not fired", async () => {
    await renderIndex();

    expect(container.querySelector("[data-testid='startup-splash']")).not.toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("shows the startup splash while the workspace selection has not loaded", async () => {
    state.anyOnlineHostServerId = "server-1";
    state.isWorkspaceSelectionLoaded = false;

    await renderIndex();

    expect(container.querySelector("[data-testid='startup-splash']")).not.toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("restores the persisted workspace when the online host matches its server id", async () => {
    state.anyOnlineHostServerId = "server-1";
    state.workspaceSelection = { serverId: "server-1", workspaceId: "workspace-a" };

    await renderIndex();

    expect(redirectMock).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });

  it("navigates to the host root when the persisted workspace targets a different server", async () => {
    state.anyOnlineHostServerId = "server-2";
    state.workspaceSelection = { serverId: "server-1", workspaceId: "workspace-a" };

    await renderIndex();

    expect(redirectMock).toHaveBeenCalledWith("/h/server-2");
  });

  it("navigates to the host root when no persisted workspace exists", async () => {
    state.anyOnlineHostServerId = "server-2";
    state.workspaceSelection = null;

    await renderIndex();

    expect(redirectMock).toHaveBeenCalledWith("/h/server-2");
  });

  it("falls back to welcome when the give-up timer fires with no host online", async () => {
    state.bootstrapState = {
      ...state.bootstrapState,
      hasGivenUpWaitingForHost: true,
    };

    await renderIndex();

    expect(redirectMock).toHaveBeenCalledWith("/welcome");
  });
});
