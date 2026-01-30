/**
 * Agent Self-ID Bridge
 *
 * Bridges stdio MCP transport to HTTP-over-Unix-socket transport.
 * This allows coding agents (which only support stdio or HTTP MCP) to
 * call set_title and set_branch on the Paseo daemon.
 *
 * Architecture:
 *   Coding Agent (Claude Code / Codex)
 *        |
 *        | stdio (newline-delimited JSON-RPC)
 *        v
 *   paseo self-id-bridge (this module)
 *        |
 *        | HTTP over Unix socket (${PASEO_HOME}/self-id-mcp.sock)
 *        v
 *   Paseo Daemon (Agent Self-ID MCP Server)
 */

import { createInterface } from "node:readline";
import http from "node:http";

export interface SelfIdBridgeOptions {
  socketPath: string;
  agentId?: string;
  debug?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

function log(debug: boolean, ...args: unknown[]): void {
  if (debug) {
    console.error("[self-id-bridge]", ...args);
  }
}

function makeHttpRequest(
  socketPath: string,
  urlPath: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function writeResponse(response: JsonRpcResponse): void {
  const line = JSON.stringify(response);
  process.stdout.write(line + "\n");
}

function writeError(id: string | number | null, code: number, message: string): void {
  writeResponse({
    jsonrpc: "2.0",
    error: { code, message },
    id,
  });
}

export async function runSelfIdBridge(options: SelfIdBridgeOptions): Promise<void> {
  const { socketPath, agentId, debug = false } = options;

  log(debug, `Starting Self-ID bridge to ${socketPath}`);
  if (agentId) {
    log(debug, `Agent ID: ${agentId}`);
  }

  let mcpSessionId: string | null = null;
  let protocolVersion: string | null = null;

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      log(debug, "Failed to parse JSON:", line);
      writeError(null, -32700, "Parse error");
      continue;
    }

    log(debug, "Request:", request.method, request.id);

    // Build headers
    const headers: Record<string, string> = {
      "Accept": "application/json, text/event-stream",
    };
    if (mcpSessionId) {
      headers["mcp-session-id"] = mcpSessionId;
    }
    if (protocolVersion && request.method !== "initialize") {
      headers["mcp-protocol-version"] = protocolVersion;
    }

    // Build URL with callerAgentId if provided
    let path = "/";
    if (agentId) {
      path = `/?callerAgentId=${encodeURIComponent(agentId)}`;
    }

    try {
      const response = await makeHttpRequest(
        socketPath,
        path,
        JSON.stringify(request),
        headers
      );

      log(debug, "Response status:", response.status);

      // Check for session ID in response headers
      const newSessionId = response.headers["mcp-session-id"];
      if (typeof newSessionId === "string" && newSessionId !== mcpSessionId) {
        mcpSessionId = newSessionId;
        log(debug, "Session ID:", mcpSessionId);
      }

      // Handle content type
      const contentType = response.headers["content-type"] ?? "";

      if (contentType.includes("text/event-stream")) {
        // SSE response - parse events and write each as a line
        const events = parseSSE(response.body);
        for (const event of events) {
          if (event.data) {
            process.stdout.write(event.data + "\n");
          }
        }
      } else {
        // JSON response - write as-is
        const jsonResponse = JSON.parse(response.body) as JsonRpcResponse;

        // Extract protocol version from initialize response
        if (request.method === "initialize" && jsonResponse.result) {
          const result = jsonResponse.result as { protocolVersion?: string };
          if (result.protocolVersion) {
            protocolVersion = result.protocolVersion;
            log(debug, "Protocol version:", protocolVersion);
          }
        }

        writeResponse(jsonResponse);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log(debug, "HTTP error:", message);

      // Check if it's a connection error
      if (message.includes("ENOENT") || message.includes("ECONNREFUSED")) {
        writeError(
          request.id ?? null,
          -32603,
          `Paseo daemon unreachable at ${socketPath}. Is the daemon running?`
        );
      } else {
        writeError(request.id ?? null, -32603, `Internal error: ${message}`);
      }
    }
  }

  log(debug, "stdin closed, exiting");
}

interface SSEEvent {
  event?: string;
  data?: string;
  id?: string;
}

function parseSSE(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let currentEvent: SSEEvent = {};
  let dataLines: string[] = [];

  for (const line of body.split("\n")) {
    if (line === "") {
      // End of event
      if (dataLines.length > 0) {
        currentEvent.data = dataLines.join("\n");
      }
      if (Object.keys(currentEvent).length > 0) {
        events.push(currentEvent);
      }
      currentEvent = {};
      dataLines = [];
      continue;
    }

    if (line.startsWith(":")) {
      // Comment, ignore
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      // Field with no value
      continue;
    }

    const field = line.slice(0, colonIndex);
    let value = line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        currentEvent.event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        currentEvent.id = value;
        break;
    }
  }

  // Handle final event if no trailing newline
  if (dataLines.length > 0) {
    currentEvent.data = dataLines.join("\n");
  }
  if (Object.keys(currentEvent).length > 0) {
    events.push(currentEvent);
  }

  return events;
}
