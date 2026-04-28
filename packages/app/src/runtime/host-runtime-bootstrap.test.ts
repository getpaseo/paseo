import { describe, expect, it, vi } from "vitest";
import {
  resolveStartupRedirectRoute,
  startHostRuntimeBootstrap,
  WELCOME_ROUTE,
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

describe("resolveStartupRedirectRoute", () => {
  const baseInput = {
    pathname: "/",
    anyOnlineHostServerId: null,
    workspaceSelection: null,
    isWorkspaceSelectionLoaded: true,
    hasGivenUpWaitingForHost: false,
  };

  it("returns null when the pathname is not the index route", () => {
    expect(
      resolveStartupRedirectRoute({
        ...baseInput,
        pathname: "/h/server-1",
        anyOnlineHostServerId: "server-1",
      }),
    ).toBeNull();
  });

  it("waits while the persisted workspace selection has not finished loading", () => {
    expect(
      resolveStartupRedirectRoute({
        ...baseInput,
        anyOnlineHostServerId: "server-1",
        isWorkspaceSelectionLoaded: false,
      }),
    ).toBeNull();
  });

  it("waits while no host is online and the give-up timer has not fired", () => {
    expect(resolveStartupRedirectRoute(baseInput)).toBeNull();
  });

  describe("scenario: saved-host-online", () => {
    it("redirects to the workspace route when the online host matches the persisted workspace", () => {
      const route = resolveStartupRedirectRoute({
        ...baseInput,
        anyOnlineHostServerId: "server-1",
        workspaceSelection: { serverId: "server-1", workspaceId: "workspace-a" },
      });

      expect(route).toBe("/h/server-1/workspace/workspace-a");
    });

    it("redirects to the host root when the persisted workspace targets a different server", () => {
      const route = resolveStartupRedirectRoute({
        ...baseInput,
        anyOnlineHostServerId: "server-2",
        workspaceSelection: { serverId: "server-1", workspaceId: "workspace-a" },
      });

      expect(route).toBe("/h/server-2");
    });

    it("redirects to the host root when no persisted workspace exists", () => {
      const route = resolveStartupRedirectRoute({
        ...baseInput,
        anyOnlineHostServerId: "server-2",
      });

      expect(route).toBe("/h/server-2");
    });
  });

  describe("scenario: daemon-start-success-only (host comes online via daemon-start upsert)", () => {
    it("redirects to the host that came online", () => {
      const route = resolveStartupRedirectRoute({
        ...baseInput,
        anyOnlineHostServerId: "srv_desktop",
      });

      expect(route).toBe("/h/srv_desktop");
    });
  });

  describe("scenario: both-succeed", () => {
    it("redirects to the host that the host runtime selects as earliest online", () => {
      const route = resolveStartupRedirectRoute({
        ...baseInput,
        anyOnlineHostServerId: "server-saved",
        workspaceSelection: { serverId: "server-saved", workspaceId: "workspace-a" },
      });

      expect(route).toBe("/h/server-saved/workspace/workspace-a");
    });
  });

  describe("scenario: both-fail (no host comes online, give-up timer fires)", () => {
    it("redirects to the welcome route", () => {
      const route = resolveStartupRedirectRoute({
        ...baseInput,
        hasGivenUpWaitingForHost: true,
      });

      expect(route).toBe(WELCOME_ROUTE);
    });

    it("still redirects to the host when one comes online before the timer expires", () => {
      const route = resolveStartupRedirectRoute({
        ...baseInput,
        anyOnlineHostServerId: "server-saved",
        hasGivenUpWaitingForHost: true,
      });

      expect(route).toBe("/h/server-saved");
    });
  });
});
