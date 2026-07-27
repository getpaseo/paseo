import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { providersSnapshotQueryKey } from "@/data/providers-snapshot";
import { refreshAndApplyProvidersSnapshot } from "@/hooks/use-providers-snapshot";

/**
 * Picking a container backend on the new-workspace screen has the daemon build
 * a throwaway container and list each provider's models inside it, because the
 * models the workspace will actually offer are the container's, not the host's.
 *
 * That build can take minutes, so this hook:
 *   - waits out rapid dropdown changes before starting one,
 *   - cancels a probe the user has moved on from (or left the screen),
 *   - remembers what each backend answered, so toggling back is instant,
 *   - and writes the answers straight into the providers-snapshot cache the
 *     model picker reads.
 *
 * The daemon removes the probe container as soon as it has answered, so the
 * entries it returns are the only ones we get — asking the daemon to refresh
 * afterwards would run on the host and report the wrong models.
 */

/** Long enough to skip past a user scrolling the dropdown, short enough to feel immediate. */
const PROBE_DEBOUNCE_MS = 350;

export type ContainerProbeStatus = "idle" | "probing" | "ready" | "error";

export interface ContainerProbeState {
  status: ContainerProbeStatus;
  /** Most recent line of container build output, for a progress hint. */
  progressLine: string | null;
  error: string | null;
  /**
   * Ask the selected environment again — a fresh container probe when a
   * backend is picked, an explicit host refresh when it isn't. The model
   * picker's Retry routes here so it never answers about the host while the
   * user is looking at a container.
   */
  retry: () => void;
  /** A retry is in flight. Separate from `status`, which is container-only. */
  isRetrying: boolean;
}

const IDLE_STATE = { status: "idle", progressLine: null, error: null } as const;

/** What the probe itself reports; `retry`/`isRetrying` are added on the way out. */
type ProbeResult = Omit<ContainerProbeState, "retry" | "isRetrying">;

export function useContainerProviderProbe(input: {
  client: DaemonClient | null;
  serverId: string;
  cwd: string | null;
  containerBackend: string | null;
}): ContainerProbeState {
  const { client, serverId, cwd, containerBackend } = input;
  const queryClient = useQueryClient();
  const [state, setState] = useState<ProbeResult>(IDLE_STATE);
  const [attempt, setAttempt] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  // Survives re-renders so switching back to a backend already probed in this
  // session costs nothing.
  const cacheRef = useRef(new Map<string, ProviderSnapshotEntry[]>());

  const retry = useCallback(() => {
    // What a backend answered is memoized; asking again is the whole point of
    // a retry, so that answer has to go first.
    cacheRef.current.delete(probeCacheKey(cwd, containerBackend));
    setIsRetrying(true);
    setAttempt((value) => value + 1);
  }, [cwd, containerBackend]);

  useEffect(() => {
    if (!client || !cwd) {
      setState(IDLE_STATE);
      setIsRetrying(false);
      return;
    }

    const applyEntries = (entries: ProviderSnapshotEntry[]): void => {
      queryClient.setQueryData(
        providersSnapshotQueryKey(serverId, cwd),
        (previous: { entries: ProviderSnapshotEntry[]; generatedAt?: string } | undefined) => ({
          ...previous,
          entries,
          generatedAt: new Date().toISOString(),
        }),
      );
    };

    if (!containerBackend) {
      // Host: ask for the host's providers explicitly. A directory can already
      // hold a container-backed workspace, and without this the daemon would
      // answer for *that* workspace's container — reporting its providers as
      // unavailable whenever it happens to be stopped.
      let cancelled = false;
      void refreshAndApplyProvidersSnapshot({
        client,
        queryClient,
        serverId,
        cwd,
        containerBackend: null,
      })
        .catch(() => {
          if (!cancelled) setState(IDLE_STATE);
        })
        .finally(() => {
          if (!cancelled) setIsRetrying(false);
        });
      setState(IDLE_STATE);
      return () => {
        cancelled = true;
      };
    }

    const cacheKey = probeCacheKey(cwd, containerBackend);
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      applyEntries(cached);
      setState({ status: "ready", progressLine: null, error: null });
      return;
    }

    const abortController = new AbortController();
    let disposed = false;
    const reportProgress = (line: string): void => {
      if (disposed) return;
      setState((previous) =>
        previous.status === "probing" ? { ...previous, progressLine: line } : previous,
      );
    };
    const timer = setTimeout(() => {
      setState({ status: "probing", progressLine: null, error: null });
      void (async () => {
        try {
          const result = await client.probeContainer(cwd, containerBackend, {
            signal: abortController.signal,
            onProgress: reportProgress,
          });
          if (disposed) return;
          if (result.cancelled) {
            // Something else superseded this probe. Leaving the state at
            // "probing" would pin the picker on "starting…" for good, with no
            // probe left to finish it.
            setState(IDLE_STATE);
            return;
          }
          if (!result.success) {
            setState({ status: "error", progressLine: null, error: result.error });
            return;
          }
          cacheRef.current.set(cacheKey, result.entries);
          applyEntries(result.entries);
          setState({ status: "ready", progressLine: null, error: null });
        } catch (error) {
          if (disposed) return;
          setState({
            status: "error",
            progressLine: null,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (!disposed) setIsRetrying(false);
        }
      })();
    }, PROBE_DEBOUNCE_MS);

    return () => {
      disposed = true;
      clearTimeout(timer);
      // Tells the daemon to stop building for a screen that has moved on.
      abortController.abort();
    };
  }, [client, serverId, cwd, containerBackend, queryClient, attempt]);

  return { ...state, retry, isRetrying };
}

/** NUL separates, because a path can hold anything else. */
function probeCacheKey(cwd: string | null, containerBackend: string | null): string {
  return `${cwd ?? ""}\0${containerBackend ?? ""}`;
}
