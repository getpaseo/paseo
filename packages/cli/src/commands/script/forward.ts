import type { Command } from "commander";
import { once } from "node:events";
import { startTcpForward } from "./forward-tcp.js";
import {
  connectWorkspaceScriptClient,
  resolveWorkspaceScriptWorkspaceId,
  type WorkspaceScriptCommandOptions,
} from "./shared.js";

interface ForwardOptions extends WorkspaceScriptCommandOptions {
  localPort?: string;
}

export async function runForwardCommand(
  scriptName: string,
  options: ForwardOptions,
  _command: Command,
): Promise<void> {
  const client = await connectWorkspaceScriptClient(options.daemonTarget);
  try {
    const workspaceId = await resolveWorkspaceScriptWorkspaceId(client, options);
    const result = await client.listWorkspaceScripts(workspaceId);
    if (result.error) throw new Error(result.error);
    const script = result.scripts?.find((item) => item.scriptName === scriptName);
    if (!script) throw new Error(`Workspace script '${scriptName}' was not found.`);
    if (script.type !== "service" || !script.port)
      throw new Error(`Workspace script '${scriptName}' has no TCP service port.`);
    if (script.lifecycle !== "running")
      throw new Error(`Start '${scriptName}' with 'paseo script start ${scriptName}' first.`);
    const requestedPort = options.localPort === undefined ? script.port : Number(options.localPort);
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535)
      throw new Error("--local-port must be between 1 and 65535.");

    const tunnel = await client.openNetworkTunnel();
    const forward = await startTcpForward(
      tunnel,
      script.port,
      requestedPort,
      options.localPort === undefined,
    );
    const host = script.hostname.endsWith(".localhost")
      ? script.hostname
      : `${script.hostname}.localhost`;
    const url = `http://${host}:${forward.port}`;
    process.stdout.write(`Forwarding ${scriptName} → ${url}\nPress Ctrl+C to stop.\n`);

    const abort = new AbortController();
    let unsubscribe = () => {};
    const disconnected = new Promise<void>((resolve) => {
      unsubscribe = tunnel.onClosed(() => resolve());
    });
    try {
      await Promise.race([
        disconnected,
        once(process, "SIGINT", { signal: abort.signal }),
        once(process, "SIGTERM", { signal: abort.signal }),
      ]);
    } finally {
      abort.abort();
      unsubscribe();
    }
    await forward.close();
    await tunnel.close();
  } finally {
    await client.close().catch(() => {});
  }
}
