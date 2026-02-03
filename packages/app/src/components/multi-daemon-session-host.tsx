import { SessionProvider } from "@/contexts/session-context";
import {
  useDaemonRegistry,
  type HostProfile,
} from "@/contexts/daemon-registry-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { buildDaemonWebSocketUrl, buildRelayWebSocketUrl, extractHostPortFromWebSocketUrl } from "@/utils/daemon-endpoints";
import { useEffect, useMemo, useRef, useState } from "react";

function buildCandidateUrls(daemon: HostProfile): string[] {
  const endpoints = daemon.endpoints ?? [];
  const sessionId = daemon.relay?.sessionId ?? null;
  const relayEndpoint = daemon.relay?.endpoint ?? null;
  const lastKnownGood =
    typeof daemon.metadata?.lastKnownGoodEndpoint === "string"
      ? (daemon.metadata.lastKnownGoodEndpoint as string)
      : null;

  const out: string[] = [];
  const push = (url: string) => {
    if (!out.includes(url)) out.push(url);
  };

  const isLastKnownRelay = !!relayEndpoint && lastKnownGood === relayEndpoint;
  const directEndpoints = endpoints;

  if (sessionId && relayEndpoint && isLastKnownRelay) {
    push(buildRelayWebSocketUrl({ endpoint: relayEndpoint, sessionId }));
  } else if (lastKnownGood) {
    push(buildDaemonWebSocketUrl(lastKnownGood));
  }

  for (const endpoint of directEndpoints) {
    push(buildDaemonWebSocketUrl(endpoint));
  }

  if (sessionId && relayEndpoint) {
    push(buildRelayWebSocketUrl({ endpoint: relayEndpoint, sessionId }));
  }

  return out;
}

function ManagedDaemonSession({ daemon }: { daemon: HostProfile }) {
  const { connectionStates } = useDaemonConnections();
  const { updateDaemon } = useDaemonRegistry();

  const candidates = useMemo(() => buildCandidateUrls(daemon), [daemon]);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeUrl = candidates[activeIndex] ?? candidates[0] ?? null;

  const lastAttemptedUrlRef = useRef<string | null>(null);
  const pendingMetadataWriteRef = useRef(false);

  useEffect(() => {
    if (!activeUrl) {
      return;
    }
    // If the active URL fell out of the candidate set (e.g. endpoints updated), snap back.
    const idx = candidates.indexOf(activeUrl);
    if (idx === -1) {
      setActiveIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.join("|")]);

  if (!activeUrl) {
    return null;
  }

  const connection = connectionStates.get(daemon.id);
  const status = connection?.status ?? "idle";
  const lastError = connection?.lastError ?? null;

  useEffect(() => {
    if (!connection) return;

      if (status === "online") {
        if (pendingMetadataWriteRef.current) return;
      const endpoint = (() => {
        try {
          return extractHostPortFromWebSocketUrl(activeUrl);
        } catch {
          return null;
        }
      })();
      if (!endpoint) return;
      if (daemon.metadata?.lastKnownGoodEndpoint === endpoint) return;

      pendingMetadataWriteRef.current = true;
      void updateDaemon(daemon.id, {
        metadata: { ...(daemon.metadata ?? {}), lastKnownGoodEndpoint: endpoint },
      }).finally(() => {
        pendingMetadataWriteRef.current = false;
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
    activeIndex,
    activeUrl,
    candidates.length,
    daemon.id,
    daemon.metadata,
    lastError,
    status,
    updateDaemon,
    connection,
  ]);

  return (
    <SessionProvider
      key={`${daemon.id}:${activeUrl}`}
      serverUrl={activeUrl}
      serverId={daemon.id}
      daemonPublicKeyB64={daemon.daemonPublicKeyB64}
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
        <ManagedDaemonSession key={daemon.id} daemon={daemon} />
      ))}
    </>
  );
}
