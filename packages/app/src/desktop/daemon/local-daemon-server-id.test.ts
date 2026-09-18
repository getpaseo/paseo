import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { DesktopDaemonStatus } from "./desktop-daemon";
import {
  LOCAL_DAEMON_SERVER_ID_QUERY_KEY,
  applyStartedLocalDaemon,
  probeLocalDaemonServerId,
  resolveLocalDaemonServerIdRefetchInterval,
  type LocalDaemonServerId,
} from "./local-daemon-server-id";

function makeStatus(overrides: Partial<DesktopDaemonStatus> = {}): DesktopDaemonStatus {
  return {
    serverId: "srv_local",
    status: "running",
    listen: "127.0.0.1:6767",
    hostname: "desktop",
    pid: 1234,
    home: "/home",
    version: "0.0.0",
    desktopManaged: true,
    ownedByDesktop: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

const STARTING = makeStatus({ serverId: "", status: "starting", listen: null });

function readCached(queryClient: QueryClient): LocalDaemonServerId | undefined {
  return queryClient.getQueryData<LocalDaemonServerId>(LOCAL_DAEMON_SERVER_ID_QUERY_KEY);
}

function seed(queryClient: QueryClient, data: LocalDaemonServerId): void {
  queryClient.setQueryData<LocalDaemonServerId>(LOCAL_DAEMON_SERVER_ID_QUERY_KEY, data);
}

function probe(queryClient: QueryClient, status: DesktopDaemonStatus) {
  return queryClient.fetchQuery({
    queryKey: LOCAL_DAEMON_SERVER_ID_QUERY_KEY,
    queryFn: () => probeLocalDaemonServerId(queryClient, async () => status),
  });
}

function refetchIntervalFor(queryClient: QueryClient): number | false {
  const state = queryClient.getQueryState<LocalDaemonServerId>(LOCAL_DAEMON_SERVER_ID_QUERY_KEY);
  if (!state) throw new Error("local daemon server id query does not exist");
  return resolveLocalDaemonServerIdRefetchInterval(state);
}

describe("local daemon server id polling", () => {
  it("does not poll when no local daemon is running", async () => {
    const queryClient = new QueryClient();
    await probe(queryClient, makeStatus({ serverId: "", status: "stopped", listen: null }));

    expect(refetchIntervalFor(queryClient)).toBe(false);
  });

  it("does not poll when the status command failed", async () => {
    const queryClient = new QueryClient();
    await probe(queryClient, makeStatus({ serverId: "", status: "errored", listen: null }));

    expect(refetchIntervalFor(queryClient)).toBe(false);
  });

  it("polls while a starting daemon has no server id", async () => {
    const queryClient = new QueryClient();
    await probe(queryClient, STARTING);

    expect(refetchIntervalFor(queryClient)).toBe(1000);
  });

  it("polls while a running daemon's server id could not be observed", async () => {
    const queryClient = new QueryClient();
    await probe(queryClient, makeStatus({ serverId: "" }));

    expect(refetchIntervalFor(queryClient)).toBe(1000);
  });

  it("stops polling once the server id is known", async () => {
    const queryClient = new QueryClient();
    await probe(queryClient, STARTING);
    await probe(queryClient, makeStatus());

    expect(readCached(queryClient)).toEqual({
      serverId: "srv_local",
      status: "running",
      probesWithoutServerId: 0,
    });
    expect(refetchIntervalFor(queryClient)).toBe(false);
  });

  it("gives up after 60 probes without a server id", async () => {
    const queryClient = new QueryClient();
    for (let attempt = 0; attempt < 59; attempt += 1) {
      await probe(queryClient, STARTING);
    }
    expect(refetchIntervalFor(queryClient)).toBe(1000);

    await probe(queryClient, STARTING);

    expect(refetchIntervalFor(queryClient)).toBe(false);
  });

  it("stops polling when a probe rejects", async () => {
    const queryClient = new QueryClient();
    await probe(queryClient, STARTING);

    await queryClient
      .fetchQuery({
        queryKey: LOCAL_DAEMON_SERVER_ID_QUERY_KEY,
        queryFn: () =>
          probeLocalDaemonServerId(queryClient, async () => {
            throw new Error("Desktop invoke() is unavailable in this environment.");
          }),
      })
      .catch(() => null);

    expect(refetchIntervalFor(queryClient)).toBe(false);
  });
});

describe("applyStartedLocalDaemon", () => {
  it("replaces a stopped observation with the started daemon's server id", async () => {
    const queryClient = new QueryClient();
    seed(queryClient, { serverId: null, status: "stopped", probesWithoutServerId: 1 });

    await applyStartedLocalDaemon(queryClient, makeStatus());

    expect(readCached(queryClient)).toEqual({
      serverId: "srv_local",
      status: "running",
      probesWithoutServerId: 0,
    });
  });

  it("restarts the polling budget for a new start", async () => {
    const queryClient = new QueryClient();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await probe(queryClient, STARTING);
    }
    expect(refetchIntervalFor(queryClient)).toBe(false);

    await applyStartedLocalDaemon(queryClient, STARTING);

    expect(refetchIntervalFor(queryClient)).toBe(1000);
  });

  it("keeps the started daemon's server id when an earlier status probe finishes later", async () => {
    const queryClient = new QueryClient();
    let finishProbe: (status: DesktopDaemonStatus) => void = () => {};
    const pendingProbe = queryClient
      .fetchQuery({
        queryKey: LOCAL_DAEMON_SERVER_ID_QUERY_KEY,
        queryFn: () =>
          probeLocalDaemonServerId(
            queryClient,
            () =>
              new Promise<DesktopDaemonStatus>((resolve) => {
                finishProbe = resolve;
              }),
          ),
      })
      .catch(() => null);

    await applyStartedLocalDaemon(queryClient, makeStatus());
    finishProbe(makeStatus({ serverId: "", status: "stopped", listen: null }));
    await pendingProbe;

    expect(readCached(queryClient)?.serverId).toBe("srv_local");
  });

  it("keeps a known server id when a start does not report one", async () => {
    const queryClient = new QueryClient();
    seed(queryClient, { serverId: "srv_local", status: "running", probesWithoutServerId: 0 });

    await applyStartedLocalDaemon(queryClient, STARTING);

    expect(readCached(queryClient)?.serverId).toBe("srv_local");
  });

  it("keeps the server id when starts with and without one are applied concurrently", async () => {
    const queryClient = new QueryClient();

    await Promise.all([
      applyStartedLocalDaemon(queryClient, makeStatus()),
      applyStartedLocalDaemon(queryClient, STARTING),
    ]);

    expect(readCached(queryClient)?.serverId).toBe("srv_local");
  });
});
