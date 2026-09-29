import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";

import { createOpenCodeTransport, OPENCODE_NO_HEADERS_TIMEOUT_MS } from "./transport.js";

/**
 * Runs `check` against a server that accepts the connection and never sends response
 * headers — the shape of OpenCode's `session.wait` long-poll while a turn is running.
 */
async function withStalledServer<T>(check: (url: string) => Promise<T>): Promise<T> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await check(`http://127.0.0.1:${port}/api/experimental/session/ses_test/wait`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("keeps waiting on a header-withholding response instead of failing at undici's headersTimeout", async () => {
  const abort = new AbortController();
  const transport = createOpenCodeTransport({ processAbort: abort.signal });
  try {
    await withStalledServer(async (url) => {
      let settled: "resolved" | "rejected" | null = null;
      const pending = transport.fetch(url, { method: "POST" }).then(
        () => (settled = "resolved"),
        () => (settled = "rejected"),
      );
      await delay(750);
      expect(settled).toBeNull();
      // The wait is ended by the helper process exiting, not by an elapsed-time deadline.
      abort.abort(new Error("OpenCode helper server exited"));
      await pending;
      expect(settled).toBe("rejected");
    });
  } finally {
    await transport.dispose();
  }
});

test("carries a configured header deadline so the dispatcher is actually applied", async () => {
  const abort = new AbortController();
  const transport = createOpenCodeTransport({
    processAbort: abort.signal,
    headersTimeoutMs: 250,
  });
  try {
    await withStalledServer(async (url) => {
      const error = await transport.fetch(url, { method: "POST" }).then(
        () => null,
        (cause: unknown) => cause as { cause?: { code?: string } },
      );
      expect(error?.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
    });
  } finally {
    await transport.dispose();
  }
});

test("OpenCode's transport has no header deadline", () => {
  // The value is the decision: any finite headersTimeout becomes a turn cap, which would
  // recreate the bug at a higher threshold.
  expect(OPENCODE_NO_HEADERS_TIMEOUT_MS).toBe(0);
});
