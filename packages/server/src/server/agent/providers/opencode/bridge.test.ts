import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { PaseoToolCatalog } from "../../tools/types.js";
import { OpenCodeBridge, loadOpenCodeBridgePluginArtifact } from "./bridge.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function createCatalog(): PaseoToolCatalog {
  const tool = {
    name: "echo_context",
    title: "Echo context",
    description: "Returns the supplied value.",
    inputSchema: { value: z.string() },
    async handler(input: unknown) {
      const parsed = z.object({ value: z.string() }).parse(input);
      return { content: [{ type: "text", text: parsed.value }] };
    },
  };
  const tools = new Map([[tool.name, tool]]);
  return {
    tools,
    getTool(name) {
      return tools.get(name);
    },
    async executeTool(name, input, context) {
      const definition = tools.get(name);
      if (!definition) throw new Error(`Unknown tool: ${name}`);
      return await definition.handler(input, context ?? {});
    },
  };
}

function readPluginOptions(env: Record<string, string>): {
  baseUrl: string;
  token: string;
  pluginUrl: string;
} {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
    plugin: Array<[string, { baseUrl: string; token: string }]>;
  };
  const [pluginUrl, options] = config.plugin[0];
  return { ...options, pluginUrl };
}

describe("OpenCodeBridge", () => {
  test("loads packaged bundle bytes without invoking source compilation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-artifact-"));
    temporaryDirectories.push(root);
    const moduleUrl = pathToFileURL(path.join(root, "bridge.js")).href;
    const bundle = Buffer.from("export default async () => ({})");
    await writeFile(path.join(root, "bridge-plugin.bundle.mjs"), bundle);
    const compileSource = vi.fn(async () => {
      throw new Error("packaged runtime must not compile");
    });

    await expect(loadOpenCodeBridgePluginArtifact(moduleUrl, compileSource)).resolves.toEqual(
      bundle,
    );
    expect(compileSource).not.toHaveBeenCalled();

    await rm(path.join(root, "bridge-plugin.bundle.mjs"));
    await expect(loadOpenCodeBridgePluginArtifact(moduleUrl, compileSource)).rejects.toThrow(
      "artifact is missing",
    );
    expect(compileSource).not.toHaveBeenCalled();
  });

  test("allows source modules to compile the development artifact", async () => {
    const artifact = new Uint8Array([1, 2, 3]);
    const compileSource = vi.fn(async () => artifact);
    const moduleUrl = new URL("./bridge.ts", import.meta.url).href;

    await expect(loadOpenCodeBridgePluginArtifact(moduleUrl, compileSource)).resolves.toBe(
      artifact,
    );
    expect(compileSource).toHaveBeenCalledWith(
      fileURLToPath(new URL("./bridge-plugin.mjs", moduleUrl)),
    );
  });

  test("serves authenticated session context and caller-scoped tools", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-opencode-bridge-"));
    temporaryDirectories.push(paseoHome);
    const catalog = createCatalog();
    const bridge = new OpenCodeBridge({ paseoHome, logger: createTestLogger() });
    await bridge.start();
    bridge.setManifestCatalog(catalog);
    const release = bridge.bindSession({
      sessionId: "ses_one",
      env: {
        PASEO_AGENT_ID: "agent-one",
        PASEO_AGENT_CWD: "/workspace/one",
        CUSTOM_VALUE: "one",
      },
      tools: catalog,
    });

    try {
      const plugin = readPluginOptions(bridge.decorateServerEnv({}));
      expect(plugin.pluginUrl).toMatch(/^file:/);

      const unauthorized = await fetch(
        `${plugin.baseUrl}/_internal/opencode/sessions/ses_one/context`,
      );
      expect(unauthorized.status).toBe(401);

      const headers = { Authorization: `Bearer ${plugin.token}` };
      const context = await fetch(`${plugin.baseUrl}/_internal/opencode/sessions/ses_one/context`, {
        headers,
      });
      expect(await context.json()).toEqual({
        env: {
          PASEO_AGENT_ID: "agent-one",
          PASEO_AGENT_CWD: "/workspace/one",
          CUSTOM_VALUE: "one",
        },
      });

      const manifest = await fetch(`${plugin.baseUrl}/_internal/opencode/tools`, { headers });
      expect(await manifest.json()).toEqual({
        tools: [
          {
            name: "echo_context",
            title: "Echo context",
            description: "Returns the supplied value.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ],
      });

      const execution = await fetch(
        `${plugin.baseUrl}/_internal/opencode/sessions/ses_one/tools/echo_context`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ value: "correct agent" }),
        },
      );
      expect(await execution.json()).toEqual({
        content: [{ type: "text", text: "correct agent" }],
      });

      const pluginModule = await import(plugin.pluginUrl);
      const hooks = await pluginModule.default(
        { client: { session: { get: async () => ({ data: {} }) } } },
        {
          baseUrl: plugin.baseUrl,
          token: plugin.token,
        },
      );
      await expect(
        hooks.tool.paseo_echo_context.execute(
          { value: "through bundled plugin" },
          { sessionID: "ses_one" },
        ),
      ).resolves.toMatchObject({ output: "through bundled plugin" });

      release();
      const pluginError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(
        hooks["shell.env"]({ cwd: "/workspace/one", sessionID: "ses_one" }, { env: {} }),
      ).rejects.toThrow("not bound");
      expect(pluginError).toHaveBeenCalledWith(
        "[paseo-opencode-plugin] shell.env failed",
        expect.objectContaining({ sessionID: "ses_one", error: expect.stringContaining("bound") }),
      );
      pluginError.mockRestore();
      const released = await fetch(
        `${plugin.baseUrl}/_internal/opencode/sessions/ses_one/context`,
        { headers },
      );
      expect(released.status).toBe(404);
    } finally {
      release();
      await bridge.close();
    }
  });

  test("preserves user OpenCode config while installing one content-addressed plugin", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-opencode-bridge-config-"));
    temporaryDirectories.push(paseoHome);
    const bridge = new OpenCodeBridge({ paseoHome, logger: createTestLogger() });
    await bridge.start();

    try {
      const first = bridge.decorateServerEnv({
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: "provider/model",
          plugin: ["user-plugin"],
        }),
      });
      const second = bridge.decorateServerEnv(first);
      const config = JSON.parse(second.OPENCODE_CONFIG_CONTENT) as {
        model: string;
        plugin: Array<string | [string, unknown]>;
      };

      expect(config.model).toBe("provider/model");
      expect(config.plugin[0]).toBe("user-plugin");
      expect(config.plugin).toHaveLength(2);
      expect(config.plugin[1]?.[0]).toMatch(/paseo-[a-f0-9]{64}\.mjs$/);
    } finally {
      await bridge.close();
    }
  });
});
