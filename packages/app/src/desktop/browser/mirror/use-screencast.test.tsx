/** @vitest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserScreencast } from "./use-screencast";
import type { PaneSize } from "./viewport";

interface ConnectionStatus {
  status: string;
}

/**
 * Every lifecycle bug in this pane has been "how many times did that subscribe?",
 * so the fake counts calls rather than modelling the daemon.
 */
const runtime = {
  subscribes: [] as Array<{ maxWidth?: number; maxHeight?: number }>,
  unsubscribes: 0,
  /** Whether the client replays the current status the moment you subscribe. */
  replayStatusOnSubscribe: true,
  listeners: [] as Array<(status: ConnectionStatus) => void>,
  client: null as unknown,
};

function emitConnection(status: string): void {
  for (const listener of runtime.listeners.slice()) {
    listener({ status });
  }
}

function createClient() {
  return {
    onBrowserScreencastFrame() {
      return () => {};
    },
    unsubscribeBrowserScreencast() {
      runtime.unsubscribes += 1;
    },
    subscribeBrowserScreencast(
      _browserId: string,
      options: { maxWidth: number; maxHeight: number },
    ) {
      runtime.subscribes.push({ maxWidth: options.maxWidth, maxHeight: options.maxHeight });
      return Promise.resolve({ error: null });
    },
    subscribeConnectionStatus(listener: (status: ConnectionStatus) => void) {
      runtime.listeners.push(listener);
      if (runtime.replayStatusOnSubscribe) {
        listener({ status: "connected" });
      }
      return () => {
        runtime.listeners = runtime.listeners.filter((entry) => entry !== listener);
      };
    },
  };
}

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
}));

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";

function renderScreencast(paneSize: PaneSize | null) {
  return renderHook(
    ({ pane }: { pane: PaneSize | null }) => useBrowserScreencast("srv", BROWSER_ID, pane),
    {
      initialProps: { pane: paneSize },
    },
  );
}

beforeEach(() => {
  runtime.subscribes = [];
  runtime.unsubscribes = 0;
  runtime.listeners = [];
  runtime.replayStatusOnSubscribe = true;
  runtime.client = createClient();
});

describe("useBrowserScreencast", () => {
  it("does not subscribe before the pane has been laid out", async () => {
    renderScreencast(null);
    await waitFor(() => expect(runtime.listeners.length).toBeGreaterThan(0));

    expect(runtime.subscribes).toEqual([]);
  });

  it("subscribes once for a mount that reports its size", async () => {
    const { rerender } = renderScreencast(null);
    rerender({ pane: { width: 1000, height: 800 } });

    await waitFor(() => expect(runtime.subscribes.length).toBeGreaterThan(0));
    // A client that replays "connected" on subscribe must not look like a
    // reconnect, or every mount re-arms the host capture for nothing.
    expect(runtime.subscribes).toHaveLength(1);
  });

  it("ignores a resize that lands inside the same quantised step", async () => {
    const { rerender } = renderScreencast({ width: 1000, height: 800 });
    await waitFor(() => expect(runtime.subscribes).toHaveLength(1));

    rerender({ pane: { width: 1004, height: 803 } });
    await Promise.resolve();

    expect(runtime.subscribes).toHaveLength(1);
  });

  it("re-subscribes once when a resize crosses a step", async () => {
    const { rerender } = renderScreencast({ width: 400, height: 400 });
    await waitFor(() => expect(runtime.subscribes).toHaveLength(1));

    rerender({ pane: { width: 1600, height: 1200 } });

    await waitFor(() => expect(runtime.subscribes).toHaveLength(2));
    expect(runtime.subscribes[1]).not.toEqual(runtime.subscribes[0]);
  });

  it("re-subscribes when the socket reconnects, because the daemon forgot the stream", async () => {
    renderScreencast({ width: 1000, height: 800 });
    await waitFor(() => expect(runtime.subscribes).toHaveLength(1));

    emitConnection("disconnected");
    emitConnection("connected");

    await waitFor(() => expect(runtime.subscribes).toHaveLength(2));
  });

  it("does not re-subscribe while the socket stays connected", async () => {
    renderScreencast({ width: 1000, height: 800 });
    await waitFor(() => expect(runtime.subscribes).toHaveLength(1));

    emitConnection("connected");
    emitConnection("connected");
    await Promise.resolve();

    expect(runtime.subscribes).toHaveLength(1);
  });
});
