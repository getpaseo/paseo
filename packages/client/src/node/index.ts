export { createHostChannelTransport } from "../hosts/index.js";
import { HostTransportBudget } from "./buffering.js";
export { HostTransportBudget } from "./buffering.js";
import { homedir } from "node:os";
import { WebSocket } from "ws";
import { parseHostTarget, type HostTarget } from "@getpaseo/protocol/host-target";
import { createSshTunnel, type SshTunnel } from "./ssh-tunnel.js";
import { createWebSocketTransportFactory } from "../daemon-client-websocket-transport.js";
import { createRelayE2eeTransportFactory } from "../daemon-client-relay-e2ee-transport.js";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  WebSocketLike,
} from "../daemon-client-transport-types.js";
import { DaemonClient, type DaemonClientConfig } from "../daemon-client.js";

export { parseHostTarget };
export type { SshTunnel } from "./ssh-tunnel.js";
export { createSshTunnel, resolveSshFailureDetail } from "./ssh-tunnel.js";

/** A factory owns one attempt, including a fresh SSH process and its teardown. */
export function createHostTransportFactory(
  connection: string,
  budget = new HostTransportBudget(),
): DaemonTransportFactory {
  const target = parseHostTarget(connection);
  return (attemptOptions) => {
    const opens = new Set<() => void>();
    const closes = new Set<(event?: unknown) => void>();
    const errors = new Set<(event?: unknown) => void>();
    const messages = new Set<(data: unknown, binary: boolean) => void>();
    let closed = false;
    let closeEvent: unknown;
    let transport: DaemonTransport | undefined;
    let teardown = () => {};
    let disposeSocket = () => {};
    let assertOutboundCapacity = (bytes: number) => budget.assertCapacity(bytes);
    let sshTunnel: SshTunnel | null = null;
    const close = (code?: number, reason?: string) => {
      if (closed) return;
      closed = true;
      try {
        transport?.close(code, reason);
      } finally {
        try {
          disposeSocket();
          teardown();
        } finally {
          for (const handler of closes) handler(closeEvent);
        }
      }
    };
    void (async () => {
      let socketTarget: Extract<HostTarget, { kind: "socket" }>;
      if (target.kind === "ssh") {
        const tunnel = await createSshTunnel(target.ssh);
        sshTunnel = tunnel;
        teardown = () => tunnel.close();
        socketTarget = parseHostTarget(tunnel.endpoint) as Extract<HostTarget, { kind: "socket" }>;
      } else socketTarget = target;
      if (closed) {
        teardown();
        return;
      }
      const socketPath = socketTarget.socketPath?.replace(/^~(?=\/)/, homedir());
      let factory = createWebSocketTransportFactory((url, options) => {
        const socket = new WebSocket(
          socketPath && url.startsWith("ws+unix:") ? `ws+unix://${socketPath}:/ws` : url,
          options?.protocols,
          {
            headers: options?.headers,
            ...(socketPath ? { socketPath } : {}),
            maxPayload: 100 * 1024 * 1024,
          },
        );
        disposeSocket = () => socket.terminate();
        assertOutboundCapacity = (bytes) => {
          if (socket.bufferedAmount + bytes > 128 * 1024 * 1024) {
            throw Object.assign(new Error("Host socket buffer limit reached"), {
              code: "resource_limit",
            });
          }
          budget.assertCapacity(bytes);
        };
        const pending = new Set<() => void>();
        const send = socket.send.bind(socket);
        socket.send = (data, ...args: unknown[]) => {
          const bytes =
            typeof data === "string"
              ? Buffer.byteLength(data)
              : Buffer.byteLength(data as Uint8Array);
          assertOutboundCapacity(bytes);
          const release = budget.reserve(bytes);
          pending.add(release);
          const callback = args.find(
            (value): value is (error?: Error) => void => typeof value === "function",
          );
          const sendOptions = args.find((value) => value !== null && typeof value === "object") as
            | { binary?: boolean }
            | undefined;
          try {
            send(data, sendOptions ?? {}, (error) => {
              release();
              pending.delete(release);
              callback?.(error);
            });
          } catch (error) {
            release();
            pending.delete(release);
            throw error;
          }
        };
        socket.once("close", () => {
          for (const release of pending) release();
          pending.clear();
        });
        return socket as unknown as WebSocketLike;
      });
      if (socketTarget.offer)
        factory = createRelayE2eeTransportFactory({
          baseFactory: factory,
          daemonPublicKeyB64: socketTarget.offer.daemonPublicKeyB64,
          logger: { warn() {} },
          assertOutboundCapacity: (bytes) => assertOutboundCapacity(bytes),
        });
      transport = factory({ ...attemptOptions, url: socketTarget.url });
      transport.onOpen(() => {
        if (!closed) for (const handler of opens) handler();
      });
      transport.onClose((event) => {
        closeEvent = event;
        close();
      });
      transport.onError((error) => {
        if (closed) return;
        const detail = sshTunnel?.failureDetail() ?? "";
        const failure =
          /permission denied|authentication failed|host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
            detail,
          )
            ? Object.assign(
                new Error(
                  "SSH authentication or host verification failed. Check the SSH configuration on this daemon.",
                ),
                { code: "authentication_failed" },
              )
            : error;
        for (const handler of errors) handler(failure);
        close();
      });
      transport.onMessage((data, binary) => {
        if (!closed) for (const handler of messages) handler(data, binary);
      });
    })().catch(() => {
      for (const handler of errors) handler(new Error("Host transport failed"));
      close();
    });
    return {
      send(data) {
        if (closed || !transport) throw new Error("Host transport is unavailable");
        transport.send(data);
      },
      close,
      onOpen(handler) {
        opens.add(handler);
        return () => opens.delete(handler);
      },
      onClose(handler) {
        closes.add(handler);
        return () => closes.delete(handler);
      },
      onError(handler) {
        errors.add(handler);
        return () => errors.delete(handler);
      },
      onMessage(handler) {
        messages.add(handler);
        return () => messages.delete(handler);
      },
    };
  };
}
export function createHostClient(
  connection: string,
  config: Omit<DaemonClientConfig, "url" | "transportFactory">,
  budget?: HostTransportBudget,
): DaemonClient {
  const target = parseHostTarget(connection);
  return new DaemonClient({
    ...config,
    url: "ws://host-connector/ws",
    ...(target.password ? { password: target.password } : {}),
    transportFactory: createHostTransportFactory(connection, budget),
  });
}
