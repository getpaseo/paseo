import { afterEach, describe, expect, test, vi } from "vitest";
import { DaemonClientV2, type DaemonTransport } from "./daemon-client-v2";

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

describe("DaemonClientV2", () => {
  const clients: DaemonClientV2[] = [];

  afterEach(async () => {
    for (const client of clients) {
      await client.close();
    }
    clients.length = 0;
  });

  test("dedupes in-flight checkout status requests per agentId", async () => {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClientV2({
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

    const client = new DaemonClientV2({
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
    expect((client as any).waiters.size).toBe(0);

    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
});
