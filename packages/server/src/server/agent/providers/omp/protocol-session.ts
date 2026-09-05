import type { Logger } from "pino";
import {
  JSONL_RPC_DEFAULT_TIMEOUT_MS,
  supportsJsonlRpcProtocolV2,
  type JsonlRpcExit,
} from "../jsonl-rpc-process.js";

const OMP_READY_TIMEOUT_MS = 20_000;

export interface OmpProtocolTransport {
  onMessage(callback: (message: Record<string, unknown>) => void): () => void;
  onExit(callback: (exit: JsonlRpcExit) => void): () => void;
  request(command: Record<string, unknown>, timeoutMs: number | null): Promise<unknown>;
}

export interface OmpProtocolTimeouts {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export async function establishOmpProtocol(
  transport: OmpProtocolTransport,
  logger: Logger,
  timeouts: OmpProtocolTimeouts = {},
): Promise<void> {
  const readyTimeoutMs = timeouts.readyTimeoutMs ?? OMP_READY_TIMEOUT_MS;
  const requestTimeoutMs = timeouts.requestTimeoutMs ?? JSONL_RPC_DEFAULT_TIMEOUT_MS;
  const ready = await waitForReady(transport, readyTimeoutMs);
  if (!supportsJsonlRpcProtocolV2(ready)) return;
  const response = (await transport.request(
    { type: "negotiate_protocol", protocolVersion: 2 },
    requestTimeoutMs,
  )) as { protocolVersion?: unknown } | undefined;
  if (response?.protocolVersion !== 2) throw new Error("OMP did not accept RPC protocol v2");
  logger.debug({}, "Negotiated OMP RPC protocol v2 (chunked frame transport)");
}

function waitForReady(
  transport: OmpProtocolTransport,
  requestTimeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribeMessage = (): void => {};
    let unsubscribeExit = (): void => {};
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for OMP to become ready")),
      requestTimeoutMs,
    );
    const finish = (result: Record<string, unknown> | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeMessage();
      unsubscribeExit();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    unsubscribeMessage = transport.onMessage((message) => {
      if (message.type === "ready") finish(message);
    });
    unsubscribeExit = transport.onExit(({ error }) => finish(error));
  });
}
