import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { clampAgentMcpProtocolVersion } from "./bootstrap.js";

describe("clampAgentMcpProtocolVersion", () => {
  it("downgrades a version newer than the bundled SDK, instead of rejecting the call", () => {
    // Claude Code 2.1.259 sends 2026-07-28; SDK 1.30.0 tops out at 2025-11-25, and the transport
    // answers 400 to every request -- the agent loses hub.reply and finishes silently.
    const request = {
      headers: { "mcp-protocol-version": "2026-07-28" } as Record<string, unknown>,
      rawHeaders: ["Accept", "application/json", "MCP-Protocol-Version", "2026-07-28"],
    };
    clampAgentMcpProtocolVersion(request);
    expect(request.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
    // The transport rebuilds the request from rawHeaders and never reads the parsed object.
    expect(request.rawHeaders[3]).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("leaves a version the SDK knows exactly as it is", () => {
    const request = { headers: { "mcp-protocol-version": "2025-06-18" } as Record<string, unknown> };
    clampAgentMcpProtocolVersion(request);
    expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("leaves an older unknown version to the SDK, which must still refuse it", () => {
    const request = { headers: { "mcp-protocol-version": "2019-01-01" } as Record<string, unknown> };
    clampAgentMcpProtocolVersion(request);
    expect(request.headers["mcp-protocol-version"]).toBe("2019-01-01");
  });

  it("ignores anything that is not a date, and a missing header", () => {
    const garbage = { headers: { "mcp-protocol-version": "latest" } as Record<string, unknown> };
    clampAgentMcpProtocolVersion(garbage);
    expect(garbage.headers["mcp-protocol-version"]).toBe("latest");

    const absent = { headers: {} as Record<string, unknown> };
    expect(() => clampAgentMcpProtocolVersion(absent)).not.toThrow();
    expect(absent.headers["mcp-protocol-version"]).toBeUndefined();
  });
});
