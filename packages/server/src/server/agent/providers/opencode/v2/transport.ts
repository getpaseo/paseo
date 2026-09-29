import { Agent } from "undici";
import type { Dispatcher } from "undici";

import { OpenCodeHttpError } from "../http-error.js";

/**
 * Disable undici's response-header deadline for OpenCode helper requests.
 *
 * undici aborts a request that has not received response headers within `headersTimeout`
 * (default 300_000 ms) with `HeadersTimeoutError` (`UND_ERR_HEADERS_TIMEOUT`). OpenCode's
 * `session.wait` is a long-poll that withholds headers until the session's agent loop goes
 * idle, so any turn longer than five minutes made Paseo surface `Transport / fetch failed /
 * Headers Timeout Error` and emit `turn_failed` while OpenCode was still running the turn.
 * There is no turn-shaped deadline to pick here: waiting is the operation.
 *
 * Paseo already treats long-running agent work as unbounded and ends it through the
 * operation's lifecycle rather than an elapsed-time deadline. `JSONL_RPC_NO_TIMEOUT`
 * (providers/jsonl-rpc-process.ts) exists for exactly this reason — its child process and
 * session close paths already reject pending RPCs — and the Codex app-server uses a 14-day
 * default for the same effect. This transport gets the same treatment. The wait is
 * cancelled by the helper process exiting (see `processAbort`), by `interrupt()` ending the
 * turn server-side, or by the session closing.
 *
 * `bodyTimeout` keeps its default so a stalled streaming response is still detected. This
 * setting applies to every request on the helper transport, not just `session.wait`; the
 * other calls return headers promptly, so the only effect is that a stuck request now ends
 * through an abort path instead of a five-minute header deadline.
 */
export const OPENCODE_NO_HEADERS_TIMEOUT_MS = 0;

interface OpenCodeTransportOptions {
  /** Aborted when the helper process exits; unioned with each request's own signal. */
  processAbort: AbortSignal;
  /** Injection seam for tests. Production uses {@link OPENCODE_NO_HEADERS_TIMEOUT_MS}. */
  headersTimeoutMs?: number;
}

export interface OpenCodeTransport {
  fetch: typeof globalThis.fetch;
  dispose(): Promise<void>;
}

export function createOpenCodeTransport(options: OpenCodeTransportOptions): OpenCodeTransport {
  const dispatcher = new Agent({
    headersTimeout: options.headersTimeoutMs ?? OPENCODE_NO_HEADERS_TIMEOUT_MS,
  });
  const openCodeFetch: typeof globalThis.fetch = async (input, init) => {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, options.processAbort])
      : options.processAbort;
    // undici reads `dispatcher` from fetch init, but the DOM `RequestInit` type has no
    // field for it, so widen the init object before passing it through.
    const requestInit = { ...init, signal, dispatcher } as RequestInit & { dispatcher: Dispatcher };
    const response = await fetch(input, requestInit);
    const html = response.headers.get("content-type")?.includes("text/html") ?? false;
    if (!response.ok || html) {
      const requestUrl = input instanceof Request ? input.url : String(input);
      throw new OpenCodeHttpError(new URL(requestUrl).pathname, response.status, html);
    }
    return response;
  };
  return { fetch: openCodeFetch, dispose: () => dispatcher.destroy() };
}
