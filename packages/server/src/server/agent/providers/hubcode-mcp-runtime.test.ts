// Unit tests for HubcodeMcpRuntime — exercise tool discovery, dispatch,
// and name-collision handling. No real transports; we inject a mock client
// factory.

import { describe, expect, it, vi } from "vitest";
import { HubcodeMcpRuntime, toFlatName } from "./hubcode-mcp-runtime";

function fakeClient(
  toolNames: string[],
  callImpl: (name: string, args: unknown) => unknown = (n, a) => ({
    content: [{ type: "text", text: `${n}(${JSON.stringify(a)})` }],
  }),
): {
  listTools: () => Promise<{
    tools: { name: string; description?: string; inputSchema?: unknown }[];
  }>;
  callTool: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
} {
  return {
    listTools: async () => ({
      tools: toolNames.map((n) => ({
        name: n,
        description: `${n} desc`,
        inputSchema: { type: "object", properties: {} },
      })),
    }),
    callTool: async ({ name, arguments: args }) => callImpl(name, args ?? {}),
    close: async () => {},
  };
}

describe("toFlatName", () => {
  it("joins server + tool with __ separator", () => {
    expect(toFlatName("hubcode", "open_workspace")).toBe("hubcode__open_workspace");
  });

  it("sanitizes invalid characters", () => {
    expect(toFlatName("my server!", "tool/with:weird.chars")).toBe(
      "my_server___tool_with_weird_chars",
    );
  });

  it("truncates to 64 chars", () => {
    const name = toFlatName("a".repeat(40), "b".repeat(40));
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("HubcodeMcpRuntime", () => {
  it("discovers tools from each server and exposes them flat", async () => {
    const factory = vi.fn(async (serverName: string) => {
      if (serverName === "alpha") return fakeClient(["read", "write"]);
      return fakeClient(["lookup"]);
    });
    const rt = new HubcodeMcpRuntime({
      servers: {
        alpha: { type: "http", url: "http://x" },
        beta: { type: "http", url: "http://y" },
      },
      clientFactory: factory as never,
    });
    const tools = await rt.listOpenAiTools();
    expect(tools.map((t) => t.function.name).sort()).toEqual([
      "alpha__read",
      "alpha__write",
      "beta__lookup",
    ]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("uniquifies tool names that collide after sanitization", async () => {
    const factory = vi.fn(async (_n: string) => fakeClient(["foo"]));
    const rt = new HubcodeMcpRuntime({
      servers: {
        x: { type: "http", url: "http://a" },
        // After sanitization both flatten to "x__foo" — second should get a suffix.
        "x ": { type: "http", url: "http://b" },
      },
      clientFactory: factory as never,
    });
    const tools = await rt.listOpenAiTools();
    const names = tools.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("dispatches invoke() to the right server", async () => {
    const seen: Array<{ server: string; name: string }> = [];
    const factory = vi.fn(async (serverName: string) =>
      fakeClient(["op"], (toolName, args) => {
        seen.push({ server: serverName, name: toolName });
        return { content: [{ type: "text", text: `${toolName}-from-${serverName}` }] };
      }),
    );
    const rt = new HubcodeMcpRuntime({
      servers: {
        a: { type: "http", url: "http://a" },
        b: { type: "http", url: "http://b" },
      },
      clientFactory: factory as never,
    });
    await rt.listOpenAiTools(); // warm cache
    const out = await rt.invoke("b__op", { x: 1 });
    expect(out).toBe("op-from-b");
    expect(seen).toEqual([{ server: "b", name: "op" }]);
  });

  it("returns a JSON error string when the tool throws", async () => {
    const factory = vi.fn(async () =>
      fakeClient(["bad"], () => {
        throw new Error("kaboom");
      }),
    );
    const rt = new HubcodeMcpRuntime({
      servers: { srv: { type: "http", url: "http://x" } },
      clientFactory: factory as never,
    });
    await rt.listOpenAiTools();
    const out = await rt.invoke("srv__bad", {});
    expect(JSON.parse(out)).toEqual({ error: "kaboom" });
  });

  it("returns Unknown tool error for unrecognized flat name", async () => {
    const factory = vi.fn(async () => fakeClient([]));
    const rt = new HubcodeMcpRuntime({
      servers: { srv: { type: "http", url: "http://x" } },
      clientFactory: factory as never,
    });
    await rt.listOpenAiTools();
    const out = await rt.invoke("nope__missing", {});
    expect(JSON.parse(out)).toEqual({ error: "Unknown tool: nope__missing" });
  });
});
