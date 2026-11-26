import { tmpdir } from "node:os";
import { expect, test } from "vitest";

import { connectMcpServer } from "./mcp-client-connection.js";
import { HttpMcpFixture } from "./providers/opencode/test-utils/mcp-fixtures.js";

test("closing finishes when an HTTP MCP server never answers the session termination", async () => {
  const server = await HttpMcpFixture.start({
    token: "token",
    marker: "MARKER",
    holdTermination: true,
  });
  try {
    const connection = await connectMcpServer({
      config: { type: "http", url: server.url, headers: { Authorization: "Bearer token" } },
      cwd: tmpdir(),
      env: {},
      clientName: "paseo-test",
    });
    await connection.close();
    expect(server.heldTerminations).toBe(1);
    await expect(connection.callTool("marker", {})).rejects.toThrow("after its connection closed");
  } finally {
    await server.close();
  }
});

test("a tool call starts a new session after the HTTP MCP server forgets the old one", async () => {
  const server = await HttpMcpFixture.start({ token: "token", marker: "MARKER" });
  try {
    const connection = await connectMcpServer({
      config: { type: "http", url: server.url, headers: { Authorization: "Bearer token" } },
      cwd: tmpdir(),
      env: {},
      clientName: "paseo-test",
    });
    await expect(connection.callTool("marker", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "MARKER" }],
    });
    server.expireSessions();
    await expect(connection.callTool("marker", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "MARKER" }],
    });
    expect(server.initializedSessions).toBe(2);
    await connection.close();
    expect(server.openSessions).toBe(0);
  } finally {
    await server.close();
  }
});

test("connecting fails when an HTTP MCP server never answers the end of the handshake", async () => {
  const server = await HttpMcpFixture.start({
    token: "token",
    marker: "MARKER",
    holdInitialized: true,
  });
  try {
    await expect(
      connectMcpServer({
        config: { type: "http", url: server.url, headers: { Authorization: "Bearer token" } },
        cwd: tmpdir(),
        env: {},
        clientName: "paseo-test",
      }),
    ).rejects.toThrow("MCP server did not connect within 10 seconds");
  } finally {
    await server.close();
  }
}, 20_000);
