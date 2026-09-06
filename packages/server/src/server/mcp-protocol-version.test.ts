import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { clampAgentMcpProtocolVersion } from "./bootstrap.js";

describe("clampAgentMcpProtocolVersion", () => {
  it("downgrades a version newer than the bundled SDK, instead of rejecting the call", () => {
    // Claude Code 2.1.259 sends 2026-07-28; SDK 1.30.0 tops out at 2025-11-25, and the transport
    // answers 400 to every request -- the agent loses hub.reply and finishes silently.
    const headers: Record<string, unknown> = { "mcp-protocol-version": "2026-07-28" };
    clampAgentMcpProtocolVersion(headers);
    expect(headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("leaves a version the SDK knows exactly as it is", () => {
    const headers: Record<string, unknown> = { "mcp-protocol-version": "2025-06-18" };
    clampAgentMcpProtocolVersion(headers);
    expect(headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("leaves an older unknown version to the SDK, which must still refuse it", () => {
    const headers: Record<string, unknown> = { "mcp-protocol-version": "2019-01-01" };
    clampAgentMcpProtocolVersion(headers);
    expect(headers["mcp-protocol-version"]).toBe("2019-01-01");
  });

  it("ignores anything that is not a date, and a missing header", () => {
    const garbage: Record<string, unknown> = { "mcp-protocol-version": "latest" };
    clampAgentMcpProtocolVersion(garbage);
    expect(garbage["mcp-protocol-version"]).toBe("latest");

    const absent: Record<string, unknown> = {};
    expect(() => clampAgentMcpProtocolVersion(absent)).not.toThrow();
    expect(absent["mcp-protocol-version"]).toBeUndefined();
  });
});
