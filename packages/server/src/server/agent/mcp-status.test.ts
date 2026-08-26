import { describe, expect, test } from "vitest";
import { configuredMcpServers, parseCodexMcpServerStatus } from "./mcp-status.js";

describe("configuredMcpServers", () => {
  test("lists the injected servers without claiming they connected", () => {
    expect(
      configuredMcpServers({
        paseo: { type: "http", url: "http://127.0.0.1/mcp/agents" },
        brain: { type: "stdio", command: "gbrain" },
      }),
    ).toEqual({
      servers: [
        { name: "brain", status: "unknown" },
        { name: "paseo", status: "unknown" },
      ],
      source: "configured",
    });
  });

  test("sorts by name so the panel does not reshuffle between refreshes", () => {
    const { servers } = configuredMcpServers({
      zebra: { type: "stdio", command: "z" },
      alpha: { type: "stdio", command: "a" },
    });
    expect(servers.map((s) => s.name)).toEqual(["alpha", "zebra"]);
  });

  test("is empty when nothing was injected", () => {
    expect(configuredMcpServers(undefined)).toEqual({ servers: [], source: "configured" });
    expect(configuredMcpServers({})).toEqual({ servers: [], source: "configured" });
  });
});

/** Shapes taken from a real `mcpServerStatus/list` response. */
describe("parseCodexMcpServerStatus", () => {
  test("reads the connection from serverInfo, which is what Codex fills in on success", () => {
    const raw = {
      data: [
        {
          name: "salt-brain",
          serverInfo: { name: "salt-brain", version: "1.0.0" },
          tools: { a: {}, b: {}, c: {} },
          authStatus: "unsupported",
        },
      ],
    };
    expect(parseCodexMcpServerStatus(raw)).toEqual({
      servers: [{ name: "salt-brain", status: "connected", toolCount: 3 }],
      source: "live",
    });
  });

  test("does not accuse a server of failing when Codex only says it is absent", () => {
    // `computer-use` is switched off in config; Codex reports that identically to a
    // crash, so claiming "Failed" would cry wolf on a deliberately disabled server.
    const raw = {
      data: [{ name: "computer-use", serverInfo: null, tools: {}, authStatus: "unsupported" }],
    };
    expect(parseCodexMcpServerStatus(raw).servers).toEqual([
      { name: "computer-use", status: "unknown" },
    ]);
  });

  test("uses auth state, the only positive evidence Codex gives, to explain an absence", () => {
    const raw = {
      data: [
        { name: "needs-login", serverInfo: null, tools: {}, authStatus: "needsAuth" },
        { name: "silent", serverInfo: null, tools: {}, authStatus: "unsupported" },
      ],
    };
    expect(parseCodexMcpServerStatus(raw).servers).toEqual([
      { name: "needs-login", status: "needs_auth" },
      { name: "silent", status: "unknown" },
    ]);
  });

  test("does not mistake an already-authenticated server for one needing a login", () => {
    const raw = {
      data: [
        {
          name: "codex_apps",
          serverInfo: { name: "plugin-runtime", version: "0.1.0" },
          tools: {},
          authStatus: "bearerToken",
        },
      ],
    };
    expect(parseCodexMcpServerStatus(raw).servers).toEqual([
      { name: "codex_apps", status: "connected", toolCount: 0 },
    ]);
  });

  test("skips entries with no usable name instead of rendering a blank row", () => {
    const raw = { data: [{ serverInfo: null }, { name: "ok", serverInfo: { name: "ok" } }] };
    expect(parseCodexMcpServerStatus(raw).servers).toEqual([{ name: "ok", status: "connected" }]);
  });

  test("rejects a response that is not the documented data array", () => {
    expect(() => parseCodexMcpServerStatus({ servers: [] })).toThrow("did not return a data array");
    expect(() => parseCodexMcpServerStatus(null)).toThrow("did not return a data array");
  });
});
