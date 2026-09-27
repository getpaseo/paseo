import type { SessionMessageInfo } from "@opencode/client";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";
import Ajv from "ajv";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { PaseoToolCatalog } from "../../tools/types.js";
import { AgentManager } from "../../agent-manager.js";
import { AgentStorage } from "../../agent-storage.js";
import { ProviderSnapshotManager } from "../../provider-snapshot-manager.js";
import { createTestAgentClients } from "../../../test-utils/fake-agent-client.js";
import { createPaseoAgentToolManifest, createPaseoToolCatalog } from "../../tools/paseo-tools.js";
import { serializePaseoToolInputParameters } from "../../tools/paseo-tool-serialization.js";
import {
  OpenCodeBridge,
  loadOpenCodeBridgePluginArtifact,
  materializeOpenCodeV2Plugin,
} from "./bridge.js";

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
  test("advertises agent-scoped schemas that execute through both bridge plugins", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-opencode-manifest-"));
    temporaryDirectories.push(paseoHome);
    const logger = createTestLogger();
    const clients = createTestAgentClients();
    const agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);
    const agentManager = new AgentManager({ clients, registry: agentStorage, logger });
    const providerSnapshotManager = new ProviderSnapshotManager({ logger, extraClients: clients });
    const dependencies = { agentManager, agentStorage, providerSnapshotManager, logger };
    const bridge = new OpenCodeBridge({ paseoHome, logger });
    await bridge.start();
    bridge.setManifestCatalog(createPaseoAgentToolManifest(dependencies));
    try {
      const parent = await agentManager.createAgent(
        { provider: "codex", cwd: paseoHome },
        undefined,
        { workspaceId: "manifest-workspace" },
      );
      const catalog = createPaseoToolCatalog({ ...dependencies, callerAgentId: parent.id });
      bridge.bindSession({ sessionId: "bound", env: {}, tools: catalog });
      const plugin = readPluginOptions(bridge.decorateServerEnv({}));
      const response = await fetch(`${plugin.baseUrl}/_internal/opencode/tools`, {
        headers: { Authorization: `Bearer ${plugin.token}` },
      });
      expect(response.status).toBe(200);
      const manifest = z
        .object({
          tools: z.array(
            z.object({
              name: z.string(),
              description: z.string(),
              inputSchema: z.record(z.string(), z.unknown()),
            }),
          ),
        })
        .parse(await response.json());
      const definitions = new Map(manifest.tools.map((tool) => [tool.name, tool]));
      const createDefinition = definitions.get("create_agent")!;
      const sendDefinition = definitions.get("send_agent_prompt")!;
      // A model can send every advertised default, including a field absent from the input below.
      const ajv = new Ajv({ useDefaults: true, strict: false });
      const createInput = {
        title: "Bridge child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Hello",
        notifyOnFinish: false,
      };
      expect(ajv.compile(createDefinition.inputSchema)(createInput)).toBe(true);

      const v2Config = z
        .object({ plugins: z.array(z.object({ package: z.string() })) })
        .parse(JSON.parse((await bridge.decorateV2ServerEnv({})).OPENCODE_CONFIG_CONTENT));
      const v2Module: {
        default: { setup(context: V2TestPluginContext): Promise<() => Promise<void>> };
      } = await import(
        pathToFileURL(path.join(fileURLToPath(v2Config.plugins[0]!.package), "server.js")).href
      );
      const tools = new Map<string, V2TestTool>();
      const dispose = await v2Module.default.setup({
        options: plugin,
        tool: {
          transform: async (transform) => {
            transform({
              add: (tool) => {
                tools.set(tool.name, tool);
              },
            });
            return { dispose: async () => undefined };
          },
        },
        session: {
          context: async () => [],
          get: async () => ({ parentID: "bound" }),
          hook: async () => ({ dispose: async () => undefined }),
        },
      });
      try {
        const created = await tools
          .get("paseo_create_agent")!
          .execute(createInput, { sessionID: "bound" });
        const children = agentManager.listAgents().filter((agent) => agent.id !== parent.id);
        expect(children).toHaveLength(1);
        const child = children[0]!;
        expect(created).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining(child.id) }],
        });
        expect(child.workspaceId).toBe("manifest-workspace");
        expect([...definitions.keys()]).toEqual([...catalog.tools.keys()]);
        for (const definition of manifest.tools) {
          const accepted = catalog.getTool(definition.name)!;
          expect(definition.inputSchema).toEqual(serializePaseoToolInputParameters(accepted));
          expect(definition.description).toBe(accepted.description);
          expect(tools.get(`paseo_${definition.name}`)!.input).toEqual(definition.inputSchema);
        }
        expect(createDefinition.inputSchema).toMatchObject({
          properties: { notifyOnFinish: { default: true } },
        });
        expect(createDefinition.inputSchema.properties).not.toHaveProperty("background");
        expect(sendDefinition.inputSchema).toMatchObject({
          properties: { background: { default: true }, notifyOnFinish: { default: true } },
        });
        await expect(
          catalog.executeTool("create_agent", { ...createInput, background: true }),
        ).rejects.toThrow("background");

        const v1Module = await import(plugin.pluginUrl);
        const hooks = await v1Module.default({}, plugin);
        expect(Object.keys(hooks.tool.paseo_create_agent.args)).toEqual(
          Object.keys(
            z.record(z.string(), z.unknown()).parse(createDefinition.inputSchema.properties),
          ),
        );
        const sendInput = { agentId: child.id, prompt: "Hello again", notifyOnFinish: false };
        expect(ajv.compile(sendDefinition.inputSchema)(sendInput)).toBe(true);
        await expect(
          hooks.tool.paseo_send_agent_prompt.execute(sendInput, { sessionID: "bound" }),
        ).resolves.toMatchObject({ output: expect.stringContaining('"success": true') });
      } finally {
        await dispose();
      }
    } finally {
      await bridge.close();
      await Promise.all(
        agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)),
      );
      await agentManager.flushForShutdown();
      await providerSnapshotManager.shutdown();
    }
  });

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

  test("v2 plugin filters caller tools and inherits child session bindings", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-opencode-v2-scope-"));
    temporaryDirectories.push(paseoHome);
    const catalog = createCatalog();
    const bridge = new OpenCodeBridge({ paseoHome, logger: createTestLogger() });
    bridge.setManifestCatalog(catalog);
    await bridge.start();
    const release = bridge.bindSession({ sessionId: "parent", env: {}, tools: catalog });
    const releaseDisabled = bridge.bindSession({ sessionId: "disabled", env: {} });
    try {
      const env = await bridge.decorateV2ServerEnv({});
      const config = z
        .object({
          plugins: z.array(
            z.object({
              package: z.string(),
              options: z.object({ baseUrl: z.string(), token: z.string() }),
            }),
          ),
        })
        .parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT));
      expect(await bridge.decorateV2ServerEnv(env)).toEqual(env);
      const plugin = config.plugins[0]!;
      const tools = new Map<string, V2TestTool>();
      let filter!: (input: V2TestContext) => Promise<void>;
      const module: {
        default: { setup(context: V2TestPluginContext): Promise<() => Promise<void>> };
      } = await import(pathToFileURL(path.join(fileURLToPath(plugin.package), "server.js")).href);
      const dispose = await module.default.setup({
        options: plugin.options,
        tool: {
          transform: async (transform) => {
            transform({
              add: (tool) => {
                tools.set(tool.name, tool);
              },
            });
            return { dispose: async () => undefined };
          },
        },
        session: {
          context: async () => [],
          get: async () => ({ parentID: "parent" }),
          hook: async (_name, callback) => {
            filter = callback;
            return { dispose: async () => undefined };
          },
        },
      });
      const allowed: V2TestContext = {
        sessionID: "child",
        tools: { paseo_echo_context: {}, native: {} },
      };
      await filter(allowed);
      expect(Object.keys(allowed.tools)).toEqual(["paseo_echo_context", "native"]);
      const disabled: V2TestContext = {
        sessionID: "disabled",
        tools: { paseo_echo_context: {}, native: {} },
      };
      await filter(disabled);
      expect(Object.keys(disabled.tools)).toEqual(["native"]);
      await expect(
        tools.get("paseo_echo_context")!.execute({ value: "child result" }, { sessionID: "child" }),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "child result" }] });
      await expect(
        tools.get("paseo_echo_context")!.execute({ value: "blocked" }, { sessionID: "disabled" }),
      ).rejects.toThrow("HTTP 403");
      await dispose();
    } finally {
      release();
      releaseDisabled();
      await bridge.close();
    }
  });

  test("v2 structured output validates values and clears its tool on ordinary turns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-v2-structured-"));
    temporaryDirectories.push(root);
    const pluginUrl = await materializeOpenCodeV2Plugin(root);
    const module: {
      default: { setup(context: V2TestPluginContext): Promise<() => Promise<void>> };
    } = await import(pathToFileURL(path.join(fileURLToPath(pluginUrl), "server.js")).href);
    const schema = {
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const history: SessionMessageInfo[] = [
      {
        id: "user",
        type: "user",
        text: "answer",
        time: { created: 1 },
        metadata: { paseoOutputSchema: schema },
      },
    ];
    const tools = new Map<string, V2TestTool>();
    let hook!: (input: V2TestContext) => Promise<void>;
    const dispose = await module.default.setup({
      options: { baseUrl: "", token: "" },
      tool: {
        transform: async (transform) => {
          transform({
            add: (tool) => {
              tools.set(tool.name, tool);
            },
          });
          return { dispose: async () => undefined };
        },
      },
      session: {
        context: async () => history,
        get: async () => ({ parentID: "parent" }),
        hook: async (_name, callback) => {
          hook = callback;
          return { dispose: async () => undefined };
        },
      },
    });
    try {
      const context: V2TestContext = {
        sessionID: "session",
        tools: { paseo_structured_output: {} },
        system: [],
      };
      await hook(context);
      expect(context.tools.paseo_structured_output.input).toMatchObject({
        properties: { value: schema },
      });
      const tool = tools.get("paseo_structured_output")!;
      await expect(
        tool.execute({ value: { answer: "wrong" } }, { sessionID: "session" }),
      ).rejects.toThrow("Invalid structured output");
      await expect(
        tool.execute({ value: { answer: 42 } }, { sessionID: "session" }),
      ).resolves.toMatchObject({ metadata: { paseoStructuredOutput: { answer: 42 } } });
      history.push({ id: "next", type: "user", text: "ordinary", time: { created: 2 } });
      await hook(context);
      expect(context.tools).toEqual({});
      await expect(
        tool.execute({ value: { answer: 42 } }, { sessionID: "session" }),
      ).rejects.toThrow("no structured-output request");
    } finally {
      await dispose();
    }
  });

  test("packages the v2 bridge as a directory with a server entry point", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-opencode-v2-package-"));
    temporaryDirectories.push(paseoHome);
    const bridge = new OpenCodeBridge({ paseoHome, logger: createTestLogger() });
    await bridge.start();
    try {
      expect(
        (await readdir(path.join(paseoHome, "runtime", "opencode"))).filter((name) =>
          name.startsWith("paseo-v2-"),
        ),
      ).toEqual([]);
      const env = await bridge.decorateV2ServerEnv({
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ["user-plugin"] }),
      });
      const config = z
        .object({ plugins: z.tuple([z.literal("user-plugin"), z.object({ package: z.string() })]) })
        .parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT));
      const directory = fileURLToPath(config.plugins[1].package);
      expect((await stat(directory)).isDirectory()).toBe(true);
      const entry = await readFile(path.join(directory, "server.js"), "utf8");
      expect(entry).toContain('id: "paseo"');
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      expect(manifest).toMatchObject({ type: "module", exports: { "./server": "./server.js" } });
    } finally {
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

interface V2TestTool {
  name: string;
  input?: unknown;
  execute(input: unknown, call: { sessionID: string }): Promise<unknown>;
}
interface V2TestContext {
  sessionID: string;
  tools: Record<string, { input?: unknown }>;
  system?: Array<{ type: "text"; text: string }>;
}
interface V2TestPluginContext {
  options: { baseUrl: string; token: string };
  tool: {
    transform(
      callback: (editor: { add(tool: V2TestTool): void }) => void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
  session: {
    context(input: { sessionID: string }): Promise<SessionMessageInfo[]>;
    get(input: { sessionID: string }): Promise<{ parentID: string }>;
    hook(
      name: string,
      callback: (input: V2TestContext) => Promise<void>,
    ): Promise<{ dispose(): Promise<void> }>;
  };
}
