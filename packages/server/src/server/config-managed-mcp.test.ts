import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

describe("daemon managed MCP config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("restores managed servers and secret sources after a daemon restart", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-managed-mcp-"));
    roots.push(paseoHome);
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            servers: {
              hub: {
                type: "http",
                url: "https://mcp.example.test/mcp",
                headers: {
                  Authorization: { source: "env", name: "MCP_HUB_TOKEN" },
                },
              },
            },
          },
        },
      }),
    );

    expect(loadConfig(paseoHome, { env: {} }).managedMcpServers).toEqual({
      hub: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: {
          Authorization: { source: "env", name: "MCP_HUB_TOKEN" },
        },
      },
    });
  });
});
