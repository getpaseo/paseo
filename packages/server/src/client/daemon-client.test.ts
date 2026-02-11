import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client";

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockTransport() {
  const sent: string[] = [];

  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};
  let onClose: (_event?: unknown) => void = () => {};
  let onError: (_event?: unknown) => void = () => {};

  const transport: DaemonTransport = {
    send: (data) => sent.push(data),
    close: () => {},
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: (handler) => {
      onClose = handler;
      return () => {};
    },
    onError: (handler) => {
      onError = handler;
      return () => {};
    },
  };

  return {
    transport,
    sent,
    triggerOpen: () => onOpen(),
    triggerClose: (event?: unknown) => onClose(event),
    triggerError: (event?: unknown) => onError(event),
    triggerMessage: (data: unknown) => onMessage(data),
  };
}

function loadLegacySnapshotFixture(): unknown {
  const url = new URL("../shared/__fixtures__/legacy-agent-stream-snapshot-inProgress.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function wrapSessionMessage(message: unknown): string {
  return JSON.stringify({
    type: "session",
    message,
  });
}

describe("DaemonClient", () => {
  const clients: DaemonClient[] = [];

  afterEach(async () => {
    for (const client of clients) {
      await client.close();
    }
    clients.length = 0;
  });

  test("dedupes in-flight checkout status requests per agentId", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const p1 = client.getCheckoutStatus("/tmp/project");
    const p2 = client.getCheckoutStatus("/tmp/project");

    expect(mock.sent).toHaveLength(1);

    const request = JSON.parse(mock.sent[0]) as {
      type: "session";
      message: { type: "checkout_status_request"; cwd: string; requestId: string };
    };

    const response = {
      type: "session",
      message: {
        type: "checkout_status_response",
        payload: {
          cwd: "/tmp/project",
          error: null,
          requestId: request.message.requestId,
          isGit: false,
          isPaseoOwnedWorktree: false,
          repoRoot: null,
          currentBranch: null,
          isDirty: null,
          baseRef: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
        },
      },
    };

    mock.triggerMessage(JSON.stringify(response));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ cwd: "/tmp/project", requestId: request.message.requestId, isGit: false });
    expect(r2).toMatchObject({ cwd: "/tmp/project", requestId: request.message.requestId, isGit: false });

    // After completion, a new call should issue a new request.
    const p3 = client.getCheckoutStatus("/tmp/project");
    expect(mock.sent).toHaveLength(2);

    const request2 = JSON.parse(mock.sent[1]) as {
      type: "session";
      message: { type: "checkout_status_request"; cwd: string; requestId: string };
    };

    mock.triggerMessage(
      JSON.stringify({
        ...response,
        message: {
          ...response.message,
          payload: { ...response.message.payload, requestId: request2.message.requestId },
        },
      })
    );

    await expect(p3).resolves.toMatchObject({
      cwd: "/tmp/project",
      requestId: request2.message.requestId,
      isGit: false,
    });
  });

  test("subscribes to checkout diff updates via RPC handshake", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const promise = client.subscribeCheckoutDiff(
      "/tmp/project",
      { mode: "uncommitted" },
      { subscriptionId: "checkout-sub-1" }
    );

    expect(mock.sent).toHaveLength(1);
    const request = JSON.parse(mock.sent[0]) as {
      type: "session";
      message: {
        type: "subscribe_checkout_diff_request";
        subscriptionId: string;
        cwd: string;
        compare: { mode: "uncommitted" | "base"; baseRef?: string };
        requestId: string;
      };
    };
    expect(request.message.type).toBe("subscribe_checkout_diff_request");
    expect(request.message.subscriptionId).toBe("checkout-sub-1");
    expect(request.message.cwd).toBe("/tmp/project");
    expect(request.message.compare).toEqual({ mode: "uncommitted" });

    mock.triggerMessage(
      JSON.stringify({
        type: "session",
        message: {
          type: "subscribe_checkout_diff_response",
          payload: {
            subscriptionId: "checkout-sub-1",
            cwd: "/tmp/project",
            files: [],
            error: null,
            requestId: request.message.requestId,
          },
        },
      })
    );

    await expect(promise).resolves.toEqual({
      subscriptionId: "checkout-sub-1",
      cwd: "/tmp/project",
      files: [],
      error: null,
      requestId: request.message.requestId,
    });
  });

  test("getCheckoutDiff uses one-shot subscription protocol", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const promise = client.getCheckoutDiff("/tmp/project", { mode: "base", baseRef: "main" });

    expect(mock.sent).toHaveLength(1);
    const subscribeRequest = JSON.parse(mock.sent[0]) as {
      type: "session";
      message: {
        type: "subscribe_checkout_diff_request";
        subscriptionId: string;
        cwd: string;
        compare: { mode: "uncommitted" | "base"; baseRef?: string };
        requestId: string;
      };
    };
    expect(subscribeRequest.message.type).toBe("subscribe_checkout_diff_request");
    expect(subscribeRequest.message.cwd).toBe("/tmp/project");
    expect(subscribeRequest.message.compare).toEqual({ mode: "base", baseRef: "main" });

    mock.triggerMessage(
      JSON.stringify({
        type: "session",
        message: {
          type: "subscribe_checkout_diff_response",
          payload: {
            subscriptionId: subscribeRequest.message.subscriptionId,
            cwd: "/tmp/project",
            files: [],
            error: null,
            requestId: subscribeRequest.message.requestId,
          },
        },
      })
    );

    await expect(promise).resolves.toEqual({
      cwd: "/tmp/project",
      files: [],
      error: null,
      requestId: subscribeRequest.message.requestId,
    });

    expect(mock.sent).toHaveLength(2);
    const unsubscribeRequest = JSON.parse(mock.sent[1]) as {
      type: "session";
      message: {
        type: "unsubscribe_checkout_diff_request";
        subscriptionId: string;
      };
    };
    expect(unsubscribeRequest.message.type).toBe("unsubscribe_checkout_diff_request");
    expect(unsubscribeRequest.message.subscriptionId).toBe(
      subscribeRequest.message.subscriptionId
    );
  });

  test("resubscribes checkout diff streams after reconnect", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const internal = client as unknown as {
      checkoutDiffSubscriptions: Map<
        string,
        { cwd: string; compare: { mode: "uncommitted" | "base"; baseRef?: string } }
      >;
    };
    internal.checkoutDiffSubscriptions.set("checkout-sub-1", {
      cwd: "/tmp/project",
      compare: { mode: "base", baseRef: "main" },
    });

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    expect(mock.sent).toHaveLength(1);
    const request = JSON.parse(mock.sent[0]) as {
      type: "session";
      message: {
        type: "subscribe_checkout_diff_request";
        subscriptionId: string;
        cwd: string;
        compare: { mode: "uncommitted" | "base"; baseRef?: string };
        requestId: string;
      };
    };
    expect(request.message.type).toBe("subscribe_checkout_diff_request");
    expect(request.message.subscriptionId).toBe("checkout-sub-1");
    expect(request.message.cwd).toBe("/tmp/project");
    expect(request.message.compare).toEqual({ mode: "base", baseRef: "main" });
    expect(typeof request.message.requestId).toBe("string");
    expect(request.message.requestId.length).toBeGreaterThan(0);
  });

  test("fetches project-grouped agents via RPC", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const promise = client.fetchAgentsGroupedByProject({
      filter: { labels: { ui: "true" } },
    });

    expect(mock.sent).toHaveLength(1);
    const request = JSON.parse(mock.sent[0]) as {
      type: "session";
      message: {
        type: "fetch_agents_grouped_by_project_request";
        requestId: string;
        filter?: { labels?: Record<string, string> };
      };
    };
    expect(request.message.type).toBe("fetch_agents_grouped_by_project_request");

    mock.triggerMessage(
      JSON.stringify({
        type: "session",
        message: {
          type: "fetch_agents_grouped_by_project_response",
          payload: {
            requestId: request.message.requestId,
            groups: [],
          },
        },
      })
    );

    await expect(promise).resolves.toEqual({
      requestId: request.message.requestId,
      groups: [],
    });
  });

  test("cancels waiters when send fails (no leaked timeouts)", async () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    const mock = createMockTransport();

    const transportFactory = () => ({
      ...mock.transport,
      send: () => {
        throw new Error("boom");
      },
    });

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const promise = client.getCheckoutStatus("/tmp/project");
    await expect(promise).rejects.toThrow("boom");

    // Ensure we didn't leave a waiter behind that will reject later.
    const internal = client as unknown as { waiters: Set<unknown> };
    expect(internal.waiters.size).toBe(0);

    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("parses canonical agent_stream tool_call payloads without crashing", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const received: unknown[] = [];
    const unsubscribe = client.on("agent_stream", (msg) => {
      received.push(msg);
    });

    mock.triggerMessage(
      wrapSessionMessage({
        type: "agent_stream",
        payload: {
          agentId: "agent_cli",
          timestamp: "2026-02-08T20:20:00.000Z",
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "call_cli_stream",
              name: "shell",
              status: "running",
              detail: {
                type: "shell",
                command: "pwd",
              },
              error: null,
            },
          },
        },
      })
    );

    unsubscribe();

    expect(received).toHaveLength(1);
    const streamMsg = received[0] as {
      payload: {
        event: {
          type: "timeline";
          item: {
            type: "tool_call";
            status: string;
            error: unknown;
            detail: {
              type: string;
            };
          };
        };
      };
    };

    expect(streamMsg.payload.event.item.status).toBe("running");
    expect(streamMsg.payload.event.item.error).toBeNull();
    expect(streamMsg.payload.event.item.detail.type).toBe("shell");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("drops legacy agent_stream tool_call payloads and logs validation warning", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const received: unknown[] = [];
    const unsubscribe = client.on("agent_stream", (msg) => {
      received.push(msg);
    });

    mock.triggerMessage(
      wrapSessionMessage({
        type: "agent_stream",
        payload: {
          agentId: "agent_cli",
          timestamp: "2026-02-08T20:20:00.000Z",
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "call_cli_stream_legacy",
              name: "shell",
              status: "inProgress",
              detail: {
                type: "unknown",
                input: { command: "pwd" },
                output: null,
              },
            },
          },
        },
      })
    );

    unsubscribe();

    expect(received).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("parses canonical agent_stream_snapshot tool_call payloads without crashing", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const received: unknown[] = [];
    const unsubscribe = client.on("agent_stream_snapshot", (msg) => {
      received.push(msg);
    });

    mock.triggerMessage(
      wrapSessionMessage({
        type: "agent_stream_snapshot",
        payload: {
          agentId: "agent_cli",
          events: [
            {
              timestamp: "2026-02-08T20:20:00.000Z",
              event: {
                type: "timeline",
                provider: "codex",
                item: {
                  type: "tool_call",
                  callId: "call_cli_snapshot",
                  name: "shell",
                  status: "running",
                  detail: {
                    type: "shell",
                    command: "pwd",
                  },
                  error: null,
                },
              },
            },
          ],
        },
      })
    );

    unsubscribe();

    expect(received).toHaveLength(1);
    const snapshotMsg = received[0] as {
      payload: {
        events: Array<{
          event: {
            type: "timeline";
            item: {
              type: "tool_call";
              status: string;
              error: unknown;
              detail: {
                type: string;
              };
            };
          };
        }>;
      };
    };

    const firstTimeline = snapshotMsg.payload.events[0]?.event;
    expect(firstTimeline?.type).toBe("timeline");
    if (firstTimeline?.type === "timeline" && firstTimeline.item.type === "tool_call") {
      expect(firstTimeline.item.status).toBe("running");
      expect(firstTimeline.item.error).toBeNull();
      expect(firstTimeline.item.detail.type).toBe("shell");
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("drops legacy agent_stream_snapshot tool_call payloads and logs validation warning", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const received: unknown[] = [];
    const unsubscribe = client.on("agent_stream_snapshot", (msg) => {
      received.push(msg);
    });

    const snapshot = loadLegacySnapshotFixture();
    mock.triggerMessage(wrapSessionMessage(snapshot));

    unsubscribe();

    expect(received).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
