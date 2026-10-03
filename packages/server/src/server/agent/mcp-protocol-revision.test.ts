import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

async function request(protocolVersion: string, method: "initialize" | "tools/list") {
  const server = new McpServer({ name: "protocol-regression", version: "1.0.0" });
  server.registerTool("ping", { description: "Protocol regression tool" }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": protocolVersion,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          ...(method === "initialize"
            ? {
                params: {
                  protocolVersion,
                  capabilities: {},
                  clientInfo: { name: "test", version: "1.0.0" },
                },
              }
            : {}),
        }),
      }),
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await server.close();
  }
}

describe("MCP protocol revision compatibility patch", () => {
  test("postinstall applies the SDK compatibility patch in a fresh dependency tree", async () => {
    const require = createRequire(import.meta.url);
    const projectRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
    const fixture = await mkdtemp(join(tmpdir(), "paseo-mcp-postinstall-"));
    try {
      const sdkRoot = resolve(
        dirname(require.resolve("@modelcontextprotocol/sdk/types.js")),
        "../..",
      );
      const fixtureSdk = join(fixture, "node_modules/@modelcontextprotocol/sdk");
      cpSync(sdkRoot, fixtureSdk, { recursive: true });
      for (const distribution of ["esm", "cjs"]) {
        const typesFile = join(fixtureSdk, "dist", distribution, "types.js");
        const original = await readFile(typesFile, "utf8");
        await writeFile(typesFile, original.replace("'2026-07-28', ", ""));
      }
      await mkdir(join(fixture, "scripts"));
      await mkdir(join(fixture, "patches"));
      await mkdir(join(fixture, "node_modules/.bin"));
      cpSync(
        join(projectRoot, "scripts/postinstall-patches.mjs"),
        join(fixture, "scripts/postinstall-patches.mjs"),
      );
      cpSync(
        join(projectRoot, "patches/@modelcontextprotocol+sdk+1.29.0.patch"),
        join(fixture, "patches/@modelcontextprotocol+sdk+1.29.0.patch"),
      );
      cpSync(join(projectRoot, "package-lock.json"), join(fixture, "package-lock.json"));
      const patchPackage = dirname(require.resolve("patch-package/package.json"));
      await symlink(
        join(patchPackage, "index.js"),
        join(fixture, "node_modules/.bin/patch-package"),
      );
      await writeFile(
        join(fixture, "package.json"),
        JSON.stringify({
          name: "mcp-postinstall-regression",
          version: "1.0.0",
          private: true,
          dependencies: { "@modelcontextprotocol/sdk": "1.29.0" },
          scripts: { postinstall: "node scripts/postinstall-patches.mjs" },
        }),
      );
      execFileSync("npm", ["run", "postinstall"], { cwd: fixture, stdio: "pipe" });
      for (const distribution of ["esm", "cjs"]) {
        expect(
          await readFile(join(fixtureSdk, "dist", distribution, "types.js"), "utf8"),
        ).toContain("'2026-07-28'");
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("accepts revision 2026-07-28 in both ESM and CommonJS distributions", () => {
    const require = createRequire(import.meta.url);
    const commonJs = require("@modelcontextprotocol/sdk/types.js") as {
      LATEST_PROTOCOL_VERSION: string;
      SUPPORTED_PROTOCOL_VERSIONS: string[];
    };
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2026-07-28");
    expect(commonJs.SUPPORTED_PROTOCOL_VERSIONS).toContain("2026-07-28");
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(commonJs.LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
  });

  test("negotiates the advertised revision at initialize", async () => {
    expect(await request("2026-07-28", "initialize")).toMatchObject({
      status: 200,
      body: { result: { protocolVersion: "2026-07-28" } },
    });
  });

  test("serves tools/list with the newer negotiated protocol header", async () => {
    expect(await request("2026-07-28", "tools/list")).toMatchObject({
      status: 200,
      body: { result: { tools: [{ name: "ping" }] } },
    });
  });

  test("preserves the older protocol and rejects unrecognized revisions", async () => {
    expect(await request("2025-11-25", "tools/list")).toMatchObject({ status: 200 });
    expect(await request("2099-01-01", "tools/list")).toMatchObject({
      status: 400,
      body: {
        error: { code: -32000, message: expect.stringContaining("Unsupported protocol version") },
      },
    });
  });
});
