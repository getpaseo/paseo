import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

let installed = false;

// Daemon-owned servers (e.g. the local OpenCode server) listen on loopback, which a remote
// proxy cannot reach, so loopback stays direct even when the user's NO_PROXY omits it.
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "[::1]"];

export interface InstallGlobalProxyDispatcherOptions {
  enabled?: boolean;
}

function resolveNoProxy(): string {
  const configured = (process.env.no_proxy ?? process.env.NO_PROXY ?? "").trim();
  // undici only treats NO_PROXY as a wildcard when the whole value is exactly "*".
  if (configured === "*") return configured;
  return [configured, ...LOOPBACK_NO_PROXY].filter(Boolean).join(",");
}

/**
 * Node's built-in fetch (undici) never reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY on its own;
 * without an explicit dispatcher every daemon-issued fetch (provider usage lookups, Hub
 * enrollment, push delivery, speech model downloads) silently bypasses the user's proxy.
 * Agent CLI subprocesses are unaffected either way — they read these vars directly from
 * their own spawned env — and the relay transport is unaffected because it talks to `ws`
 * directly, never through this dispatcher.
 *
 * Called from bootstrap.ts, gated by `PaseoDaemonConfig.globalProxyDispatcher` (default true).
 * This mutates the process-wide undici dispatcher, so a host embedding `createPaseoDaemon`
 * alongside its own fetch consumers should pass `globalProxyDispatcher: false` and manage
 * proxying itself rather than have it installed underneath it.
 */
export function installGlobalProxyDispatcher({
  enabled = true,
}: InstallGlobalProxyDispatcherOptions = {}): void {
  if (!enabled || installed) return;
  installed = true;
  setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: resolveNoProxy() }));
}
