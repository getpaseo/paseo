import { describe, expect, it, vi } from "vitest";
import {
  resolveHostIndexRoute,
  resolveStartupBlocker,
  resolveStartupNavigationReady,
  resolveStartupRoute,
  shouldRunStartupGiveUpTimer,
  startHostRuntimeBootstrap,
} from "./host-runtime-bootstrap";

function createFakeStore() {
  return { boot: vi.fn() };
}

function createFakeDaemonStartService() {
  return {
    start: vi.fn(async () => ({ ok: true as const })),
  };
}

describe("startHostRuntimeBootstrap", () => {
  it("fires boot and daemon-start without awaiting the daemon-start promise", () => {
    const events: string[] = [];
    const store = {
      boot: vi.fn(() => {
        events.push("boot");
      }),
    };
    const daemonStartService = {
      start: vi.fn(async () => {
        events.push("daemon-start");
        return { ok: true as const };
      }),
    };

    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: true,
    });

    expect(store.boot).toHaveBeenCalledTimes(1);
    expect(daemonStartService.start).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["boot", "daemon-start"]);
  });

  it("skips daemon-start when shouldStartDaemon is false", () => {
    const store = createFakeStore();
    const daemonStartService = createFakeDaemonStartService();

    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: false,
    });

    expect(store.boot).toHaveBeenCalledTimes(1);
    expect(daemonStartService.start).not.toHaveBeenCalled();
  });

  it("skips daemon-start when the startup gate resolves false", async () => {
    const store = createFakeStore();
    const daemonStartService = createFakeDaemonStartService();

    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: async () => false,
    });
    await Promise.resolve();

    expect(store.boot).toHaveBeenCalledTimes(1);
    expect(daemonStartService.start).not.toHaveBeenCalled();
  });

  it("surfaces gate rejection to onGateError without starting the daemon", async () => {
    const store = createFakeStore();
    const daemonStartService = createFakeDaemonStartService();
    const onGateError = vi.fn();

    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: async () => {
        throw new Error("settings file unreadable");
      },
      onGateError,
    });
    await vi.waitFor(() => {
      expect(onGateError).toHaveBeenCalledTimes(1);
    });

    expect(daemonStartService.start).not.toHaveBeenCalled();
    expect(onGateError).toHaveBeenCalledWith(expect.stringContaining("settings file unreadable"));
  });

  it("does not await the daemon-start promise", () => {
    const store = createFakeStore();
    let resolveStart: ((value: { ok: true }) => void) | undefined;
    const daemonStartService = {
      start: vi.fn(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    };

    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: true,
    });

    expect(store.boot).toHaveBeenCalledTimes(1);
    expect(daemonStartService.start).toHaveBeenCalledTimes(1);

    resolveStart?.({ ok: true });
  });
});

describe("startup blocking policy", () => {
  const noBlockerInput = {
    isDesktopRuntime: false,
    anyOnlineHostServerId: null,
    daemonStartIsRunning: false,
    daemonStartError: null,
  };

  it("runs the give-up timer when no startup blocker is active", () => {
    const blocker = resolveStartupBlocker(noBlockerInput);

    expect(blocker).toEqual({ kind: "none" });
    expect(resolveStartupNavigationReady({ startupBlocker: blocker })).toBe(true);
    expect(
      shouldRunStartupGiveUpTimer({
        startupBlocker: blocker,
        anyOnlineHostServerId: null,
        hasGivenUpWaitingForHost: false,
      }),
    ).toBe(true);
  });

  it("blocks navigation while desktop is starting the managed daemon", () => {
    const blocker = resolveStartupBlocker({
      ...noBlockerInput,
      isDesktopRuntime: true,
      daemonStartIsRunning: true,
    });

    expect(blocker).toEqual({ kind: "managed-daemon-starting" });
    expect(resolveStartupNavigationReady({ startupBlocker: blocker })).toBe(false);
    expect(
      shouldRunStartupGiveUpTimer({
        startupBlocker: blocker,
        anyOnlineHostServerId: null,
        hasGivenUpWaitingForHost: false,
      }),
    ).toBe(false);
  });

  it("unblocks navigation when any host is online", () => {
    const blocker = resolveStartupBlocker({
      ...noBlockerInput,
      isDesktopRuntime: true,
      anyOnlineHostServerId: "srv_desktop",
      daemonStartIsRunning: true,
    });

    expect(blocker).toEqual({ kind: "none" });
    expect(resolveStartupNavigationReady({ startupBlocker: blocker })).toBe(true);
  });

  it("keeps desktop daemon startup errors on the startup error surface", () => {
    const blocker = resolveStartupBlocker({
      ...noBlockerInput,
      isDesktopRuntime: true,
      daemonStartError: "daemon failed to start",
    });

    expect(blocker).toEqual({
      kind: "managed-daemon-error",
      message: "daemon failed to start",
    });
    expect(resolveStartupNavigationReady({ startupBlocker: blocker })).toBe(true);
    expect(
      shouldRunStartupGiveUpTimer({
        startupBlocker: blocker,
        anyOnlineHostServerId: null,
        hasGivenUpWaitingForHost: false,
      }),
    ).toBe(false);
  });
});

describe("resolveStartupRoute", () => {
  const baseIndexInput = {
    route: { kind: "index" as const, pathname: "/" },
    startupBlocker: { kind: "none" as const },
    hostRegistryStatus: "ready" as const,
    hosts: [],
    anyOnlineHostServerId: null,
    workspaceSelection: null,
    workspaceSelectionStatus: "unknown" as const,
    isWorkspaceSelectionLoaded: true,
    hasGivenUpWaitingForHost: false,
  };
  const baseHostInput = {
    route: { kind: "host" as const, serverId: "server-saved" },
    startupBlocker: { kind: "none" as const },
    hostRegistryStatus: "ready" as const,
    hosts: [],
  };

  it("renders non-index routes instead of making an index startup decision", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        route: { kind: "index", pathname: "/settings" },
      }),
    ).toEqual({ kind: "render" });
  });

  it("keeps startup on the splash while the persisted workspace selection is loading", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        anyOnlineHostServerId: "server-1",
        isWorkspaceSelectionLoaded: false,
      }),
    ).toEqual({ kind: "splash" });
  });

  it("keeps startup on the splash while the host registry is loading", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        hostRegistryStatus: "loading",
      }),
    ).toEqual({ kind: "splash" });
  });

  it("does not treat loading hosts as an empty registry when a workspace is already restored", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        hostRegistryStatus: "loading",
        workspaceSelection: { serverId: "server-1", workspaceId: "workspace-a" },
        hasGivenUpWaitingForHost: true,
      }),
    ).toEqual({ kind: "splash" });
  });

  it("restores the saved workspace only after the host registry proves the host exists", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        hosts: [{ serverId: "server-1" }],
        workspaceSelection: { serverId: "server-1", workspaceId: "workspace-a" },
        workspaceSelectionStatus: "exists",
      }),
    ).toEqual({ kind: "redirect", href: "/h/server-1/workspace/workspace-a" });
  });

  it("does not restore a saved workspace after workspace hydration proves it is missing", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        hosts: [{ serverId: "server-1" }],
        workspaceSelection: { serverId: "server-1", workspaceId: "workspace-a" },
        workspaceSelectionStatus: "missing",
      }),
    ).toEqual({ kind: "redirect", href: "/h/server-1" });
  });

  it("falls back to a saved host when the restored workspace host is no longer saved", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        workspaceSelection: { serverId: "server-saved", workspaceId: "workspace-a" },
        hosts: [{ serverId: "server-next" }],
        hasGivenUpWaitingForHost: true,
      }),
    ).toEqual({ kind: "redirect", href: "/h/server-next" });
  });

  it("redirects to the online host when no saved workspace is selected", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        anyOnlineHostServerId: "srv-desktop",
      }),
    ).toEqual({ kind: "redirect", href: "/h/srv-desktop" });
  });

  it("keeps a known connecting host in app-owned routing instead of showing welcome", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        hosts: [{ serverId: "server-saved" }],
        hasGivenUpWaitingForHost: true,
      }),
    ).toEqual({ kind: "redirect", href: "/h/server-saved" });
  });

  it("shows welcome after root startup gives up and no host exists", () => {
    expect(
      resolveStartupRoute({
        ...baseIndexInput,
        hasGivenUpWaitingForHost: true,
      }),
    ).toEqual({ kind: "redirect", href: "/welcome" });
  });

  it("keeps host routes mounted while the host registry is loading", () => {
    expect(
      resolveStartupRoute({
        ...baseHostInput,
        hostRegistryStatus: "loading",
      }),
    ).toEqual({ kind: "render" });
  });

  it("keeps host routes mounted while the managed daemon is starting", () => {
    expect(
      resolveStartupRoute({
        ...baseHostInput,
        startupBlocker: { kind: "managed-daemon-starting" },
      }),
    ).toEqual({ kind: "render" });
  });

  it("renders a host route once the route host is known", () => {
    expect(
      resolveStartupRoute({
        ...baseHostInput,
        hosts: [{ serverId: "server-saved" }],
      }),
    ).toEqual({ kind: "render" });
  });

  it("sends removed host routes to a saved host instead of welcome", () => {
    expect(
      resolveStartupRoute({
        ...baseHostInput,
        route: { kind: "host", serverId: "server-removed" },
        hosts: [{ serverId: "server-next" }],
      }),
    ).toEqual({ kind: "redirect", href: "/h/server-next/open-project" });
  });

  it("shows welcome from a host route only after the registry proves no hosts exist", () => {
    expect(
      resolveStartupRoute({
        ...baseHostInput,
        route: { kind: "host", serverId: "server-removed" },
      }),
    ).toEqual({ kind: "redirect", href: "/welcome" });
  });
});

describe("resolveHostIndexRoute", () => {
  it("restores the remembered workspace when the host index is reopened for the same host", () => {
    expect(
      resolveHostIndexRoute({
        serverId: "server-saved",
        workspaceSelection: { serverId: "server-saved", workspaceId: "workspace-a" },
        workspaceSelectionStatus: "exists",
      }),
    ).toEqual("/h/server-saved/workspace/workspace-a");
  });

  it("keeps restoring a remembered workspace before the host workspace list hydrates", () => {
    expect(
      resolveHostIndexRoute({
        serverId: "server-saved",
        workspaceSelection: { serverId: "server-saved", workspaceId: "workspace-a" },
        workspaceSelectionStatus: "unknown",
      }),
    ).toEqual("/h/server-saved/workspace/workspace-a");
  });

  it("opens project selection when the remembered workspace is proven missing", () => {
    expect(
      resolveHostIndexRoute({
        serverId: "server-saved",
        workspaceSelection: { serverId: "server-saved", workspaceId: "workspace-a" },
        workspaceSelectionStatus: "missing",
      }),
    ).toEqual("/h/server-saved/open-project");
  });

  it("opens project selection when the remembered workspace belongs to another host", () => {
    expect(
      resolveHostIndexRoute({
        serverId: "server-saved",
        workspaceSelection: { serverId: "server-other", workspaceId: "workspace-a" },
        workspaceSelectionStatus: "exists",
      }),
    ).toEqual("/h/server-saved/open-project");
  });
});
