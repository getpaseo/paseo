import { useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useFetchQuery } from "@/data/query";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { readValidatedJson, readValidatedString } from "@/storage/validated-storage";
import {
  LOCAL_DESKTOP_OPEN_EXECUTION,
  REMOTE_UNCONFIGURED_DESKTOP_OPEN_EXECUTION,
  type DesktopOpenExecution,
  type RemoteDestination,
} from "@/workspace/desktop-open-targets";

/**
 * An SSH destination: `[user@]host[:port]`, with nothing that would break the URI authority
 * each editor builds from it. The Electron main process enforces the same shape at the IPC
 * boundary; this copy exists so the settings form can reject a bad value as it is typed.
 */
const SSH_DESTINATION_PATTERN = /^[A-Za-z0-9._@:-]+$/u;

const SshHostSchema = z.string().trim().regex(SSH_DESTINATION_PATTERN);

const RemoteDestinationSchema = z.object({
  kind: z.literal("ssh"),
  host: SshHostSchema,
});

/** Device-local storage: the only writer is this client, so it can be re-read lazily. */
const STALE_TIME_MS = 60_000;

/**
 * The binding lives on the client, never in the daemon config: the destination comes from
 * this machine's own SSH config and its reachability is a client-side fact. Two clients on
 * the same daemon can need different values, and the daemon can neither verify nor
 * invalidate one.
 */
function storageKey(serverId: string): string {
  return `@paseo:editor-remote-destination:${serverId}`;
}

/** Held only long enough to migrate; this key never shipped outside the feature branch. */
function legacyAuthorityStorageKey(serverId: string): string {
  return `@paseo:editor-remote-authority:${serverId}`;
}

function queryKey(serverId: string): readonly string[] {
  return ["editor-remote-destination", serverId];
}

export function isSshHost(value: string): boolean {
  return SshHostSchema.safeParse(value).success;
}

/**
 * The destination to store for a typed host, or `null` when it is empty or malformed. A
 * pasted `ssh-remote+dev` is accepted as `dev`: an earlier version of this field asked for
 * the VS Code authority, so that is what some users will have to hand.
 */
export function sshDestination(host: string): RemoteDestination | null {
  const trimmed = host.trim();
  const value = trimmed.startsWith("ssh-remote+") ? trimmed.slice("ssh-remote+".length) : trimmed;
  return isSshHost(value) ? { kind: "ssh", host: value } : null;
}

/** Prefill for the SSH host field, or `""` when the reported hostname cannot be one. */
export function suggestSshHost(hostname: string | null): string {
  const trimmed = hostname?.trim() ?? "";
  return isSshHost(trimmed) ? trimmed : "";
}

async function migrateLegacyAuthority(serverId: string): Promise<RemoteDestination | null> {
  const legacyKey = legacyAuthorityStorageKey(serverId);
  const authority = await readValidatedString(AsyncStorage, legacyKey, z.string().trim().min(1));
  if (!authority) {
    return null;
  }
  await AsyncStorage.removeItem(legacyKey);
  const destination = sshDestination(authority);
  if (!destination) {
    return null;
  }
  await AsyncStorage.setItem(storageKey(serverId), JSON.stringify(destination));
  return destination;
}

/** The read path, including the one-way migration off the pre-release authority key. */
export async function loadEditorRemoteDestination(
  serverId: string,
): Promise<RemoteDestination | null> {
  const stored = await readValidatedJson(
    AsyncStorage,
    storageKey(serverId),
    RemoteDestinationSchema,
  );
  return stored ?? (await migrateLegacyAuthority(serverId));
}

interface EditorRemoteDestination {
  /** `undefined` while loading, `null` when this host has no destination configured. */
  remoteDestination: RemoteDestination | null | undefined;
  updateRemoteDestination: (destination: RemoteDestination | null) => Promise<void>;
}

export function useEditorRemoteDestination(serverId: string): EditorRemoteDestination {
  const queryClient = useQueryClient();
  const normalizedServerId = serverId.trim();
  const { data, isPending } = useFetchQuery({
    queryKey: queryKey(normalizedServerId),
    queryFn: () => loadEditorRemoteDestination(normalizedServerId),
    enabled: normalizedServerId.length > 0,
    dataShape: "value",
    staleTimeMs: STALE_TIME_MS,
    gcTime: Infinity,
  });

  const updateRemoteDestination = useCallback(
    async (destination: RemoteDestination | null) => {
      const parsed = destination ? RemoteDestinationSchema.safeParse(destination) : null;
      const stored = parsed?.success ? parsed.data : null;
      queryClient.setQueryData(queryKey(normalizedServerId), stored);
      if (stored) {
        await AsyncStorage.setItem(storageKey(normalizedServerId), JSON.stringify(stored));
        return;
      }
      await AsyncStorage.removeItem(storageKey(normalizedServerId));
    },
    [normalizedServerId, queryClient],
  );

  return {
    remoteDestination: isPending && normalizedServerId.length > 0 ? undefined : (data ?? null),
    updateRemoteDestination,
  };
}

/**
 * Where a desktop editor would have to look to open this host's files, or `null` when the
 * answer is not known yet. Stays `null` until both the local daemon identity and the stored
 * destination resolve, so a host is never treated as remote before we know whether it is
 * this machine, and an unconfigured entry never flashes ahead of a configured one.
 */
export function useDesktopOpenExecution(serverId: string): DesktopOpenExecution | null {
  const localDaemon = useLocalDaemonServerIdState();
  const { remoteDestination } = useEditorRemoteDestination(serverId);
  const normalizedServerId = serverId.trim();

  return useMemo(() => {
    if (localDaemon.status !== "resolved" || normalizedServerId.length === 0) {
      return null;
    }
    if (localDaemon.serverId === normalizedServerId) {
      return LOCAL_DESKTOP_OPEN_EXECUTION;
    }
    if (remoteDestination === undefined) {
      return null;
    }
    return remoteDestination
      ? { kind: "remote", destination: remoteDestination }
      : REMOTE_UNCONFIGURED_DESKTOP_OPEN_EXECUTION;
  }, [localDaemon, normalizedServerId, remoteDestination]);
}
