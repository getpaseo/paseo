import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { testManagedMcpServer } from "./managed-mcp-tester.js";

const fixturePath = fileURLToPath(
  new URL("../test-utils/managed-mcp-stdio-fixture.ts", import.meta.url),
);

describe("managed MCP tester", () => {
  test("connects to a real stdio MCP server and lists its tools", async () => {
    const result = await testManagedMcpServer({
      config: {
        type: "stdio",
        command: process.execPath,
        args: ["--import", "tsx", fixturePath],
      },
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ status: "success", toolCount: 1 });
  });

  test("redacts direct secrets from connection failures", async () => {
    const secret = "private-command-token";
    const result = await testManagedMcpServer({
      config: {
        type: "stdio",
        command: `/missing/${secret}`,
        env: { MCP_TEST_TOKEN: secret },
      },
      timeoutMs: 1_000,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain(secret);
  });
});
