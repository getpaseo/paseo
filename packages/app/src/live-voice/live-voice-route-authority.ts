interface LiveVoiceRouteSnapshot {
  phase: "idle" | "starting" | "active" | "stopping" | "error";
  serverId: string | null;
  liveSessionId: string | null;
}

interface LiveVoiceRouteRuntime {
  getSnapshot(): LiveVoiceRouteSnapshot;
}

interface RegisteredLiveVoiceRuntime {
  token: symbol;
  runtime: LiveVoiceRouteRuntime;
}

let registeredRuntime: RegisteredLiveVoiceRuntime | null = null;

/**
 * Registers the app-global Live Voice runtime as the authority for cross-host
 * route requests. The token prevents a stale provider cleanup (for example
 * during Fast Refresh) from clearing a newer provider's registration.
 */
export function registerLiveVoiceRouteAuthority(runtime: LiveVoiceRouteRuntime): () => void {
  const token = Symbol("live-voice-route-authority");
  registeredRuntime = { token, runtime };
  return () => {
    if (registeredRuntime?.token === token) {
      registeredRuntime = null;
    }
  };
}

/**
 * A paired daemon is not automatically allowed to use the app as a bridge to
 * every other host. Routing is authorized only for the exact call the user
 * currently owns on that source daemon.
 */
export function isAuthorizedLiveVoiceRoute(sourceServerId: string, liveSessionId: string): boolean {
  const snapshot = registeredRuntime?.runtime.getSnapshot();
  if (!snapshot) {
    return false;
  }
  return (
    (snapshot.phase === "starting" || snapshot.phase === "active") &&
    snapshot.serverId === sourceServerId &&
    snapshot.liveSessionId === liveSessionId
  );
}
