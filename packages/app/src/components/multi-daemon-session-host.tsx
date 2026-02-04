import { SessionProvider } from "@/contexts/session-context";
import {
  useDaemonRegistry,
  type HostProfile,
} from "@/contexts/daemon-registry-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
} from "@/utils/daemon-endpoints";
import { probeDaemonEndpoint } from "@/utils/test-daemon-connection";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActiveConnection } from "@/contexts/daemon-connections-context";

type Candidate = {
  connectionId: string;
  url: string;
  activeConnection: ActiveConnection;
  daemonPublicKeyB64?: string;
};

function sortConnectionsByPreference<T extends { id: string }>(
  connections: T[],
  preferredId: string | null
): T[] {
  if (!preferredId) return connections;
  const idx = connections.findIndex((c) => c.id === preferredId);
  if (idx === -1) return connections;
  return [connections[idx]!, ...connections.slice(0, idx), ...connections.slice(idx + 1)];
}

function buildCandidates(host: HostProfile): Candidate[] {
  const preferred = host.preferredConnectionId ?? null;

  const direct = sortConnectionsByPreference(
    host.connections.filter((c) => c.type === "direct"),
    preferred
  );
  const relay = sortConnectionsByPreference(
    host.connections.filter((c) => c.type === "relay"),
    preferred
  );

  const out: Candidate[] = [];

  for (const conn of direct) {
    out.push({
      connectionId: conn.id,
      url: buildDaemonWebSocketUrl(conn.endpoint),
      activeConnection: { type: "direct", endpoint: conn.endpoint, display: conn.endpoint },
    });
  }

  for (const conn of relay) {
    out.push({
      connectionId: conn.id,
      url: buildRelayWebSocketUrl({
        endpoint: conn.relayEndpoint,
        serverId: host.serverId,
      }),
      activeConnection: { type: "relay", endpoint: conn.relayEndpoint, display: "relay" },
      daemonPublicKeyB64: conn.daemonPublicKeyB64,
    });
  }

  return out;
}

function ManagedDaemonSession({ daemon }: { daemon: HostProfile }) {
  const { connectionStates } = useDaemonConnections();
  const { updateHost } = useDaemonRegistry();

  const candidates = useMemo(() => buildCandidates(daemon), [daemon]);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = candidates[activeIndex] ?? candidates[0] ?? null;
  const activeUrl = active?.url ?? null;

  const lastAttemptedUrlRef = useRef<string | null>(null);
  const pendingPreferenceWriteRef = useRef(false);
  const upgradeProbeInFlightRef = useRef(false);

  useEffect(() => {
    if (!activeUrl) {
      return;
    }
    // If the active URL fell out of the candidate set (e.g. endpoints updated), snap back.
    const idx = candidates.findIndex((c) => c.url === activeUrl);
    if (idx === -1) {
      setActiveIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.map((c) => c.url).join("|")]);

  if (!activeUrl) {
    return null;
  }

  const connection = connectionStates.get(daemon.serverId);
  const status = connection?.status ?? "idle";
  const lastError = connection?.lastError ?? null;

  useEffect(() => {
    if (!connection) return;

    if (status === "online") {
      if (!active) return;
      if (pendingPreferenceWriteRef.current) return;
      if (daemon.preferredConnectionId === active.connectionId) return;

      pendingPreferenceWriteRef.current = true;
      void updateHost(daemon.serverId, {
        preferredConnectionId: active.connectionId,
      }).finally(() => {
        pendingPreferenceWriteRef.current = false;
      });
      return;
    }

    if ((status === "error" || (status === "offline" && lastError)) && candidates.length > 1) {
      if (lastAttemptedUrlRef.current === activeUrl) {
        return;
      }
      lastAttemptedUrlRef.current = activeUrl;
      if (activeIndex < candidates.length - 1) {
        setActiveIndex((idx) => Math.min(idx + 1, candidates.length - 1));
      }
    }
  }, [
    active,
    activeIndex,
    activeUrl,
    candidates.length,
    daemon.preferredConnectionId,
    daemon.serverId,
    lastError,
    status,
    updateHost,
    connection,
  ]);

  useEffect(() => {
    if (!connection) return;
    if (status !== "online") return;
    if (activeIndex === 0) return;

    const best = candidates[0];
    if (!best) return;
    if (best.activeConnection.type !== "direct") return;

    const intervalMs = 15_000;
    let cancelled = false;

    const attemptUpgrade = async () => {
      if (cancelled) return;
      if (upgradeProbeInFlightRef.current) return;
      if (activeIndex === 0) return;

      upgradeProbeInFlightRef.current = true;
      try {
        const { serverId } = await probeDaemonEndpoint(best.activeConnection.endpoint, {
          timeoutMs: 2000,
        });
        if (cancelled) return;
        if (serverId !== daemon.serverId) return;

        lastAttemptedUrlRef.current = null;
        setActiveIndex(0);
      } catch {
        // ignore - we'll retry periodically
      } finally {
        upgradeProbeInFlightRef.current = false;
      }
    };

    void attemptUpgrade();
    const interval = setInterval(() => void attemptUpgrade(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeIndex, candidates, connection, daemon.serverId, status]);

  return (
    <SessionProvider
      key={`${daemon.serverId}:${activeUrl}`}
      serverUrl={activeUrl}
      serverId={daemon.serverId}
      activeConnection={active?.activeConnection ?? null}
      daemonPublicKeyB64={active?.daemonPublicKeyB64}
    >
      {null}
    </SessionProvider>
  );
}

export function MultiDaemonSessionHost() {
  const { daemons } = useDaemonRegistry();
  if (daemons.length === 0) {
    return null;
  }

  return (
    <>
      {daemons.map((daemon) => (
        <ManagedDaemonSession key={daemon.serverId} daemon={daemon} />
      ))}
    </>
  );
}
