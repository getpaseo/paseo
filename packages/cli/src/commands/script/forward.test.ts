import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { Command } from "commander";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { runForwardCommand } from "./forward.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./shared.js", () => ({
  connectWorkspaceScriptClient: connect,
  resolveWorkspaceScriptWorkspaceId: async () => "workspace",
}));

afterEach(() => vi.restoreAllMocks());

it("falls back only for the default port and closes the listener when the service exits", async () => {
  // The test daemon also occupies the requested local port.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;
  let endService = () => {};

  const service = {
    scriptName: "web",
    type: "service",
    lifecycle: "running",
    terminalId: "term",
    port,
    hostname: "web--demo",
  };
  const close = vi.fn(async () => {});
  connect.mockResolvedValue({
    subscribeConnectionStatus: () => () => {},
    listWorkspaceScripts: async () => ({ scripts: [service] }),
    observeEvents: () => ({
      ready: Promise.resolve(),
      subscribe: ({ update }: { update: (event: unknown) => void }) => {
        endService = () =>
          update({
            type: "script_status_update",
            payload: { workspaceId: "workspace", scripts: [] },
          });
      },
    }),
    createNetworkTunnelTicket: async () => ({ ticket: "fixture-ticket" }),
    close,
  });
  const hellos: unknown[] = [];
  server.on("connection", (ws) =>
    ws.once("message", (bytes) => {
      hellos.push(JSON.parse(bytes.toString()));
      ws.send(
        JSON.stringify({
          type: "tunnel_ready",
          initialStreamWindowBytes: 65536,
          initialConnectionWindowBytes: 65536,
          maxFramePayloadBytes: 16384,
        }),
      );
    }),
  );
  const options = { daemonTarget: { kind: "endpoint", host } as const };
  try {
    await expect(
      runForwardCommand("web", { ...options, localPort: String(port) }, new Command()),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    let bound = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      const match = /http:\/\/web--demo\.localhost:(\d+)/.exec(String(chunk));
      if (match) {
        bound = Number(match[1]);
        endService();
      }
      return true;
    });
    await runForwardCommand("web", options, new Command());
    expect(bound).toBeGreaterThan(0);
    expect(bound).not.toBe(port);
    const socket = net.connect(bound, "127.0.0.1");
    const [error] = await once(socket, "error");
    expect(error.code).toBe("ECONNREFUSED");
    expect(hellos).toEqual(Array(2).fill({ type: "tunnel_hello", ticket: "fixture-ticket" }));
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
