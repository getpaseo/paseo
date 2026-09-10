import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface LifecycleShutdownRuntime {
  readServerId(home: string): string;
  connect(options: {
    host: string;
    timeout: number;
  }): Promise<Pick<DaemonClient, "getLastServerInfoMessage" | "shutdownServer" | "close"> | null>;
}

interface ShutdownTarget {
  home: string;
  hasLiveOwner: boolean;
  host: string | null;
  timeoutMs: number;
}

type LifecycleShutdownAttempt = { requested: true } | { requested: false; reason: string };

export class DaemonIdentityMismatchError extends Error {
  constructor(
    readonly home: string,
    readonly host: string,
  ) {
    super(`Refusing to stop daemon at ${host}: its identity does not match ${home}`);
    this.name = "DaemonIdentityMismatchError";
  }
}

export async function requestLifecycleShutdown(
  target: ShutdownTarget,
  runtime: LifecycleShutdownRuntime,
): Promise<LifecycleShutdownAttempt> {
  const { host, timeoutMs } = target;
  if (!host) {
    return {
      requested: false,
      reason: "daemon listen target is not TCP, falling back to owner PID signal",
    };
  }
  // Do not create an identity while trying to stop an absent or incomplete home.
  let expectedServerId: string;
  try {
    expectedServerId = runtime.readServerId(target.home).trim();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    expectedServerId = "";
  }
  if (!expectedServerId) {
    return {
      requested: false,
      reason: `daemon identity is missing in ${target.home}, falling back to owner PID signal`,
    };
  }
  const deadline = Date.now() + timeoutMs;
  const remainingTimeoutMs = () => Math.max(1, deadline - Date.now());
  const client = await runtime.connect({ host, timeout: Math.min(remainingTimeoutMs(), 5000) });
  if (!client) {
    return {
      requested: false,
      reason: `daemon websocket at ${host} is not reachable, falling back to owner PID signal`,
    };
  }
  try {
    if (client.getLastServerInfoMessage()?.serverId !== expectedServerId) {
      if (!target.hasLiveOwner) {
        return {
          requested: false,
          reason: `daemon at ${host} belongs to another home; no live owner in ${target.home}`,
        };
      }
      throw new DaemonIdentityMismatchError(target.home, host);
    }
    await client.shutdownServer({ timeout: Math.min(remainingTimeoutMs(), 5000) });
    return { requested: true };
  } catch (error) {
    // A port collision is not permission to fall back to another destructive action.
    if (error instanceof DaemonIdentityMismatchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      requested: false,
      reason: `daemon lifecycle shutdown request failed (${message}), falling back to owner PID signal`,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
