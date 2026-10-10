import { describe, expect, it, vi } from "vitest";
import {
  buildDesktopDaemonTransportUrl,
  createDesktopDaemonTransportFactory,
} from "./desktop-daemon-transport";
import { createFakeLocalDaemonTransportRpc } from "./test-local-daemon-transport-rpc";

const LOCAL_URL = "paseo+desktop://socket?path=%2Ftmp%2Fpaseo.sock";

describe("desktop-daemon-transport", () => {
  it("uses the main-process event as readiness when it races registration", async () => {
    const rpc = createFakeLocalDaemonTransportRpc();
    const cleanup = vi.fn();
    const transportFactory = createDesktopDaemonTransportFactory(rpc);
    expect(transportFactory).not.toBeNull();

    const transport = transportFactory!({ url: LOCAL_URL });

    const onOpen = vi.fn();
    transport.onOpen(onOpen);

    rpc.resolveListen(cleanup);
    await Promise.resolve();

    const sessionId = rpc.openCalls[0]?.sessionId ?? "";
    expect(sessionId).not.toBe("");
    rpc.emitEvent({ sessionId, kind: "open" });
    expect(onOpen).toHaveBeenCalledTimes(1);

    rpc.resolveRegistration();
    await Promise.resolve();

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not start a session when listener setup finishes after close", async () => {
    const rpc = createFakeLocalDaemonTransportRpc();
    const cleanup = vi.fn();

    const transportFactory = createDesktopDaemonTransportFactory(rpc);
    expect(transportFactory).not.toBeNull();

    const transport = transportFactory!({ url: LOCAL_URL });

    transport.close();

    rpc.resolveListen(cleanup);
    await Promise.resolve();
    await Promise.resolve();

    expect(rpc.openCalls).toHaveLength(0);
    expect(rpc.closedSessions).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cancels a registered session while readiness is pending", async () => {
    const rpc = createFakeLocalDaemonTransportRpc();
    const transportFactory = createDesktopDaemonTransportFactory(rpc);
    expect(transportFactory).not.toBeNull();

    const transport = transportFactory!({ url: LOCAL_URL });
    rpc.resolveListen(vi.fn());
    await Promise.resolve();

    const sessionId = rpc.openCalls[0]?.sessionId ?? "";
    expect(sessionId).not.toBe("");

    transport.close();

    expect(rpc.closedSessions).toEqual([sessionId]);
  });

  it("passes Remote SSH parameters to the desktop transport bridge", async () => {
    const rpc = createFakeLocalDaemonTransportRpc();
    const transportFactory = createDesktopDaemonTransportFactory(rpc);
    expect(transportFactory).not.toBeNull();

    const url = buildDesktopDaemonTransportUrl({
      transportType: "ssh",
      host: "deploy@example.com",
      sshPort: 2222,
      daemonPort: 7777,
    });
    transportFactory!({ url });
    rpc.resolveListen(vi.fn());
    await Promise.resolve();

    expect(rpc.openCalls).toHaveLength(1);
    expect(rpc.openCalls[0]?.target).toEqual({
      transportType: "ssh",
      host: "deploy@example.com",
      sshPort: 2222,
      daemonPort: 7777,
    });
  });

  it.each([0, 65536])("rejects an out-of-range Remote SSH port (%s)", (sshPort) => {
    const transportFactory = createDesktopDaemonTransportFactory(
      createFakeLocalDaemonTransportRpc(),
    );
    expect(transportFactory).not.toBeNull();

    const url = buildDesktopDaemonTransportUrl({
      transportType: "ssh",
      host: "deploy@example.com",
      sshPort,
    });

    expect(() => transportFactory!({ url })).toThrow("Invalid SSH transport target");
  });
});

it("closes a bridge session that finishes opening after disposal", async () => {
  const rpc = createFakeLocalDaemonTransportRpc();
  const transport = createDesktopDaemonTransportFactory(rpc)!({ url: LOCAL_URL });
  rpc.resolveListen(vi.fn());
  await Promise.resolve();
  const sessionId = rpc.openCalls[0].sessionId;
  transport.close();
  expect(rpc.closedSessions).toEqual([sessionId]);
  rpc.resolveRegistration();
  await Promise.resolve();
  expect(rpc.closedSessions).toEqual([sessionId, sessionId]);
});

it("preserves text and binary frame order across asynchronous bridge calls", async () => {
  const rpc = createFakeLocalDaemonTransportRpc();
  let finishFirst!: () => void;
  const firstSend = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const send = vi
    .fn()
    .mockImplementationOnce(() => firstSend)
    .mockResolvedValue(undefined);
  rpc.sendMessage = send;
  const transport = createDesktopDaemonTransportFactory(rpc)!({ url: LOCAL_URL });
  rpc.resolveListen(vi.fn());
  await Promise.resolve();
  const sessionId = rpc.openCalls[0].sessionId;
  rpc.emitEvent({ sessionId, kind: "open" });

  transport.send("first");
  transport.send(new Uint8Array([1, 2, 3]));
  transport.send("last");
  await Promise.resolve();
  expect(send.mock.calls).toEqual([[{ sessionId, text: "first" }]]);

  finishFirst();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(send.mock.calls).toEqual([
    [{ sessionId, text: "first" }],
    [{ sessionId, binaryBase64: "AQID" }],
    [{ sessionId, text: "last" }],
  ]);
  transport.close();
});
