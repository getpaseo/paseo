import type { IncomingMessage } from "node:http";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

// COMPAT(mcpProtocolVersionClip): added in v0.12.1; remove after 2027-04-21 once the bundled
// MCP SDK accepts the protocol versions current clients send.

/**
 * Normalizes an unsupported `mcp-protocol-version` request header to the newest
 * version the bundled MCP SDK server supports.
 *
 * MCP clients can negotiate a protocol newer than the bundled server knows
 * (2026-07-28, DRAFT-2026-v1). The streamable-HTTP transport checks this header
 * on every request but `initialize` and rejects an unknown version before it
 * reads the JSON-RPC body, so such a client fails on its first request after
 * `initialize`; `initialize` itself already negotiates down in its body.
 *
 * Node lowercases only `headers` and keeps wire case in `rawHeaders`, and
 * `@hono/node-server` builds the Web Request from `rawHeaders`, so both are
 * rewritten. Duplicate raw pairs (same name, any case) collapse to one, because
 * Hono joins them into a comma-separated value the SDK server also rejects.
 */
export function clipMcpProtocolVersionHeader(
  req: Pick<IncomingMessage, "headers" | "rawHeaders">,
): void {
  const current = req.headers["mcp-protocol-version"];
  if (typeof current !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(current)) {
    return;
  }
  const clipped = SUPPORTED_PROTOCOL_VERSIONS[0];
  req.headers["mcp-protocol-version"] = clipped;
  let replaced = false;
  for (let i = 0; i < req.rawHeaders.length - 1; ) {
    if (req.rawHeaders[i].toLowerCase() === "mcp-protocol-version") {
      if (replaced) {
        req.rawHeaders.splice(i, 2);
      } else {
        req.rawHeaders[i + 1] = clipped;
        replaced = true;
        i += 2;
      }
    } else {
      i += 2;
    }
  }
}
