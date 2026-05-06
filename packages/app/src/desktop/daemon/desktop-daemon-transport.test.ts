import { describe, expect, it, vi, beforeEach } from "vitest";

const desktopDaemonMock = vi.hoisted(() => {
  let eventHandler:
    | ((payload: {
        sessionId: string;
        kind: "open" | "message" | "close" | "error";
        text?: string | null;
        binaryBase64?: string | null;
        code?: number | null;
        reason?: string | null;
        error?: string | null;
      }) => void)
    | null = null;

  const openLocalTransportSession = vi.fn<(...args: unknown[]) => Promise<string>>();
  const listenToLocalTransportEvents = vi.fn(
    async (
      handler: typeof eventHandler extends ((...args: infer A) => unknown) | null
        ? (...args: A) => void
        : never,
    ) => {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },
  );
  const sendLocalTransportMessage = vi.fn(async () => undefined);
  const closeLocalTransportSession = vi.fn(async () => undefined);

  return {
    openLocalTransportSession,
    listenToLocalTransportEvents,
    sendLocalTransportMessage,
    closeLocalTransportSession,
    emitEvent(payload: {
      sessionId: string;
      kind: "open" | "message" | "close" | "error";
      text?: string | null;
      binaryBase64?: string | null;
      code?: number | null;
      reason?: string | null;
      error?: string | null;
    }) {
      eventHandler?.(payload);
    },
  };
});

vi.mock("./desktop-daemon", () => ({
  openLocalTransportSession: desktopDaemonMock.openLocalTransportSession,
  listenToLocalTransportEvents: desktopDaemonMock.listenToLocalTransportEvents,
  sendLocalTransportMessage: desktopDaemonMock.sendLocalTransportMessage,
  closeLocalTransportSession: desktopDaemonMock.closeLocalTransportSession,
}));

describe("desktop-daemon-transport", () => {
  beforeEach(() => {
    desktopDaemonMock.openLocalTransportSession.mockReset();
    desktopDaemonMock.listenToLocalTransportEvents.mockClear();
    desktopDaemonMock.sendLocalTransportMessage.mockClear();
    desktopDaemonMock.closeLocalTransportSession.mockClear();
  });

  it("emits open after the session resolves even if the rust open event raced earlier", async () => {
    let resolveSession!: (sessionId: string) => void;
    desktopDaemonMock.openLocalTransportSession.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSession = resolve;
        }),
    );

    const mod = await import("./desktop-daemon-transport");
    const transportFactory = mod.createDesktopLocalDaemonTransportFactory();
    expect(transportFactory).not.toBeNull();

    const transport = transportFactory!({
      url: "paseo+local://socket?path=%2Ftmp%2Fpaseo.sock",
    });

    const onOpen = vi.fn();
    transport.onOpen(onOpen);

    desktopDaemonMock.emitEvent({
      sessionId: "local-session-1",
      kind: "open",
    });

    expect(onOpen).not.toHaveBeenCalled();

    resolveSession("local-session-1");
    await Promise.resolve();

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("cleans up late async setup after the transport is closed", async () => {
    let resolveSession!: (sessionId: string) => void;
    let resolveListen!: (cleanup: () => void) => void;
    const cleanup = vi.fn();

    desktopDaemonMock.openLocalTransportSession.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSession = resolve;
        }),
    );
    desktopDaemonMock.listenToLocalTransportEvents.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );

    const mod = await import("./desktop-daemon-transport");
    const transportFactory = mod.createDesktopLocalDaemonTransportFactory();
    expect(transportFactory).not.toBeNull();

    const transport = transportFactory!({
      url: "paseo+local://socket?path=%2Ftmp%2Fpaseo.sock",
    });

    transport.close();

    resolveSession("local-session-2");
    resolveListen(cleanup);
    await Promise.resolve();
    await Promise.resolve();

    expect(desktopDaemonMock.closeLocalTransportSession).toHaveBeenCalledWith("local-session-2");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
