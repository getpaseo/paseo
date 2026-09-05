import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

let installed = false;

/**
 * Node's built-in fetch (undici) never reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY on its own;
 * without an explicit dispatcher every daemon-issued fetch (provider usage lookups, Hub
 * enrollment, push delivery, speech model downloads) silently bypasses the user's proxy.
 * Agent CLI subprocesses are unaffected either way — they read these vars directly from
 * their own spawned env — and the relay transport is unaffected because it talks to `ws`
 * directly, never through this dispatcher.
 */
export function installGlobalProxyDispatcher(): void {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
