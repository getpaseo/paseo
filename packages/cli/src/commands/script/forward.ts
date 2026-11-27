import type { Command } from "commander";
import { parseHostTarget } from "@getpaseo/client/node";
import {
  createOsSocketOwnerVerifier,
  openPlainWebSocketTunnel,
  startLocalForward,
  TunnelMuxClient,
} from "@getpaseo/client/internal/node-network-tunnel";
import { once } from "node:events";
import {
  connectWorkspaceScriptClient,
  resolveWorkspaceScriptWorkspaceId,
  type WorkspaceScriptCommandOptions,
} from "./shared.js";

type ForwardOptions = WorkspaceScriptCommandOptions & { localPort?: string };
function resolveForwardOptions(options: ForwardOptions) {
  const target =
    options.daemonTarget.kind === "endpoint" && parseHostTarget(options.daemonTarget.host);
  if (!target || target.kind !== "socket" || target.socketPath || target.offer) {
    throw new Error("CLI forwarding requires a direct TCP or WebSocket daemon endpoint (--host).");
  }
  const localPort = options.localPort === undefined ? undefined : Number(options.localPort);
  if (
    localPort !== undefined &&
    (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
  ) {
    throw new Error("--local-port must be between 1 and 65535.");
  }
  return { url: target.url, localPort };
}

export async function runForwardCommand(
  scriptName: string,
  options: ForwardOptions,
  _command: Command,
): Promise<void> {
  const { url, localPort } = resolveForwardOptions(options);
  const client = await connectWorkspaceScriptClient(options.daemonTarget);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const verifyOwner = createOsSocketOwnerVerifier();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const unsubscribe = client.subscribeConnectionStatus(({ status }) => {
    if (status !== "connected") stop();
  });
  try {
    const workspaceId = await resolveWorkspaceScriptWorkspaceId(client, options);
    const result = await client.listWorkspaceScripts(workspaceId);
    if (result.error) throw new Error(result.error);
    const service = result.scripts?.find((item) => item.scriptName === scriptName);
    if (
      service?.type !== "service" ||
      service.lifecycle !== "running" ||
      !service.port ||
      !service.terminalId
    )
      throw new Error(`No running service named '${scriptName}' in this workspace.`);
    const remotePort = service.port;
    const matchesService = (scripts: typeof result.scripts) =>
      scripts?.some(
        (item) =>
          item.scriptName === scriptName &&
          item.type === "service" &&
          item.lifecycle === "running" &&
          item.port === remotePort &&
          item.terminalId === service.terminalId,
      );
    const observation = client.observeEvents(["script_status_update"]);
    observation.subscribe({
      snapshot: () => {},
      update(message) {
        if (
          message.type === "script_status_update" &&
          message.payload.workspaceId === workspaceId &&
          !matchesService(message.payload.scripts)
        )
          stop();
      },
      error: stop,
    });
    await observation.ready;
    // Cover changes between the initial selection and registration of the subscription.
    const snapshot = await client.listWorkspaceScripts(workspaceId);
    if (snapshot.error) throw new Error(snapshot.error);
    if (!matchesService(snapshot.scripts) || controller.signal.aborted) return;
    const { ticket } = await client.createNetworkTunnelTicket();
    const mux = new TunnelMuxClient(
      await openPlainWebSocketTunnel({ url, ticket, timeoutMs: 15000 }),
    );
    mux.onClose(stop);
    try {
      if (controller.signal.aborted || mux.isClosed()) return;
      const forward = await startLocalForward({
        remotePort,
        localPort,
        verifyOwner,
        mux,
      });
      try {
        const host = service.hostname.endsWith(".localhost")
          ? service.hostname
          : `${service.hostname}.localhost`;
        process.stdout.write(
          `Forwarding ${scriptName} at http://${host}:${forward.port} (127.0.0.1:${forward.port}). Press Ctrl+C to stop.\n`,
        );
        if (!controller.signal.aborted) await once(controller.signal, "abort");
      } finally {
        await forward.close();
      }
    } finally {
      mux.close();
    }
  } finally {
    unsubscribe();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    verifyOwner.dispose?.();
    await client.close();
  }
}
