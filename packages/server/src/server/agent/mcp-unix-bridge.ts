import { Agent, request, type IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { createParser } from "eventsource-parser";

interface UnixMcpBridgeOptions {
  socketPath: string;
  agentId: string;
  token?: string;
}

/** Relay MCP messages to the daemon's stateless HTTP endpoint without changing its tool catalog. */
export async function startUnixMcpBridge(options: UnixMcpBridgeOptions) {
  const transport = new StdioServerTransport();
  const agent = new Agent({ keepAlive: true });
  const active = new Set<AbortController>();
  const requests = new Map<RequestId, AbortController>();
  const tasks = new Set<Promise<void>>();
  let protocolVersion: string | undefined;
  let closing: Promise<void> | undefined;

  function report(error: unknown) {
    process.stderr.write(
      `Paseo Unix MCP: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  function postMessage(message: JSONRPCMessage, signal: AbortSignal): Promise<IncomingMessage> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(
        {
          socketPath: options.socketPath,
          path: `/mcp/agents?callerAgentId=${encodeURIComponent(options.agentId)}`,
          method: "POST",
          headers,
          agent,
          signal,
        },
        resolve,
      );
      outgoing.once("error", reject);
      outgoing.end(JSON.stringify(message));
    });
  }

  async function sendUpstream(message: JSONRPCMessage): Promise<void> {
    const id = "method" in message && "id" in message ? message.id : undefined;
    const controller = new AbortController();
    active.add(controller);
    if (id !== undefined) requests.set(id, controller);
    let answered = false;
    try {
      const response = await postMessage(message, controller.signal);
      if (response.statusCode === 202 || response.statusCode === 204) {
        response.resume();
        if (id !== undefined) throw new Error("Daemon accepted an MCP request without a reply");
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error(`Daemon returned HTTP ${response.statusCode}`);
      }

      async function receive(reply: JSONRPCMessage) {
        if ("id" in reply && reply.id === id) {
          answered = true;
          if ("method" in message && message.method === "initialize" && "result" in reply) {
            const version = reply.result.protocolVersion;
            if (typeof version === "string") protocolVersion = version;
          }
        }
        if (!closing && !controller.signal.aborted) await transport.send(reply);
      }

      for await (const reply of readMcpMessages(response)) await receive(reply);
      if (id !== undefined && !answered)
        throw new Error("Daemon closed the MCP response without a reply");
    } catch (error) {
      if (closing || controller.signal.aborted) return;
      if (id !== undefined && !answered) {
        await transport.send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `Paseo Unix MCP: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      } else {
        report(error);
      }
    } finally {
      active.delete(controller);
      if (id !== undefined && requests.get(id) === controller) requests.delete(id);
    }
  }

  // MCP transports expose callbacks rather than EventTarget methods.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message) => {
    if (closing) return;
    if ("method" in message && message.method === "notifications/cancelled") {
      const id = message.params?.requestId;
      if (typeof id === "string" || typeof id === "number") requests.get(id)?.abort();
      return;
    }
    const task = sendUpstream(message).catch(report);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onerror = report;
  await transport.start();

  async function shutdown(): Promise<void> {
    for (const controller of active) controller.abort();
    agent.destroy();
    await transport.close();
    await Promise.allSettled(tasks);
  }

  return {
    close(): Promise<void> {
      closing ??= shutdown();
      return closing;
    },
  };
}

async function* readMcpMessages(response: IncomingMessage): AsyncGenerator<JSONRPCMessage> {
  const contentType = response.headers["content-type"] ?? "";
  // Node's decoder preserves UTF-8 characters split across network chunks.
  response.setEncoding("utf8");
  if (contentType.includes("text/event-stream")) {
    const events: string[] = [];
    const parser = createParser({ onEvent: (event) => events.push(event.data) });
    for await (const chunk of response) {
      parser.feed(String(chunk));
      for (const event of events.splice(0)) yield JSONRPCMessageSchema.parse(JSON.parse(event));
    }
  } else if (contentType.includes("application/json")) {
    let body = "";
    for await (const chunk of response) body += String(chunk);
    yield JSONRPCMessageSchema.parse(JSON.parse(body));
  } else {
    response.destroy();
    throw new Error(`Unsupported MCP response content type: ${contentType}`);
  }
}
