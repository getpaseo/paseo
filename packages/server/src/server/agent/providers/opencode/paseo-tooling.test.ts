import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ensureOpenCodePaseoToolingRuntime } from "./paseo-tooling.js";

describe("OpenCode Paseo tooling plugin", () => {
  const originalPaseoHome = process.env.PASEO_HOME;

  afterEach(() => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    vi.restoreAllMocks();
  });

  test("normalizes OpenCode string arguments before executing Paseo tools", async () => {
    const paseoHome = mkdtempSync(path.join(os.tmpdir(), "opencode-paseo-tooling-test-"));
    process.env.PASEO_HOME = paseoHome;
    const runtime = ensureOpenCodePaseoToolingRuntime();
    const postedBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathname = new URL(url.toString()).pathname;
      if (pathname === "/api/paseo-tooling/manifest") {
        return new Response(
          JSON.stringify({
            tools: [
              {
                name: "list_agents",
                description: "List agents",
                inputJsonSchema: {
                  type: "object",
                  properties: {
                    includeArchived: { type: "boolean", default: false },
                    sinceHours: { type: "integer", default: 48 },
                    statuses: {
                      type: "array",
                      items: { type: "string", enum: ["running", "idle"] },
                    },
                    limit: { type: "integer", default: 50 },
                  },
                  additionalProperties: false,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      postedBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ output: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const plugin = (await import(
        `${pathToFileURL(runtime.pluginPath).href}?test=${Date.now()}`
      )) as {
        server: (
          input: unknown,
          options: { baseUrl: string; token: string },
        ) => Promise<{
          tool: Record<
            string,
            { execute: (args: unknown, context: { sessionID: string }) => Promise<string> }
          >;
        }>;
      };
      const server = await plugin.server({}, { baseUrl: "http://127.0.0.1:6767", token: "t" });

      await server.tool.paseo_list_agents?.execute(
        {
          includeArchived: "False",
          sinceHours: "",
          statuses: '["running"]',
          limit: "5",
        },
        { sessionID: "session-1" },
      );

      expect(postedBodies).toEqual([
        {
          provider: "opencode",
          sessionId: "session-1",
          tool: "list_agents",
          input: {
            includeArchived: false,
            statuses: ["running"],
            limit: 5,
          },
        },
      ]);
    } finally {
      rmSync(paseoHome, { recursive: true, force: true });
    }
  });
});
