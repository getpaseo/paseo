import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";

interface Binding {
  sessionID: string;
  baseUrl: string;
  token: string;
}
interface TestTool {
  name: string;
  execute(input: { value: string }, call: { sessionID: string }): Promise<unknown>;
}
interface TestContext {
  sessionID: string;
  tools: Record<string, unknown>;
  system: unknown[];
}

test("a shared plugin binds Paseo sessions without involving unrelated sessions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-shared-bridge-"));
  const bridge = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
  const tool = { name: "echo", description: "echo", inputSchema: { value: z.string() } };
  const tools = new Map([[tool.name, tool]]);
  bridge.setManifestCatalog({ tools });
  await bridge.start();
  const unbind = bridge.bindSession({
    sessionId: "paseo",
    env: {},
    tools: {
      tools,
      getTool: (name) => tools.get(name),
      executeTool: async (_name, input) => ({
        content: [{ type: "text", text: String((input as { value: string }).value) }],
      }),
    },
  });
  expect(() => bridge.bindSession({ sessionId: "paseo", env: {} })).toThrow("already bound");
  try {
    const plugin = {
      package: await bridge.materializeV2Plugin(),
      options: bridge.sharedV2Connection(),
    };
    const module = await import(
      pathToFileURL(path.join(fileURLToPath(plugin.package), "server.js")).href
    );
    const installed = new Map<string, TestTool>();
    const hooks: Array<(input: TestContext) => Promise<void>> = [];
    const refreshed: string[] = [];
    let structured = false;
    let rpc: Record<string, (input: Binding) => Promise<unknown>> = {};
    const context = {
      options: {},
      location: { directory: home },
      provider: {
        reload: async () => {
          refreshed.push("provider");
        },
      },
      model: {
        reload: async () => {
          refreshed.push("model");
        },
      },
      agent: {
        reload: async () => {
          refreshed.push("agent");
        },
      },
      command: {
        reload: async () => {
          refreshed.push("command");
        },
      },
      skill: {
        reload: async () => {
          refreshed.push("skill");
        },
      },
      rpc: {
        register: async (_definition: unknown, handlers: typeof rpc) => {
          rpc = handlers;
          return { dispose: async () => {} };
        },
      },
      tool: {
        transform: async (fn: (editor: { add(item: TestTool): void }) => void) => {
          fn({ add: (item) => installed.set(item.name, item) });
          return { dispose: async () => {} };
        },
      },
      session: {
        context: async () =>
          structured ? [{ type: "user", metadata: { paseoOutputSchema: { type: "string" } } }] : [],
        get: async () => ({ parentID: "" }),
        hook: async (_name: string, fn: (input: TestContext) => Promise<void>) => {
          hooks.push(fn);
          return { dispose: async () => {} };
        },
      },
    };
    let dispose = await module.default.setup(context);
    await rpc.bind({ sessionID: "paseo", ...plugin.options });
    await rpc.refresh({ sessionID: "paseo", ...plugin.options });
    expect(refreshed).toEqual(["provider", "model", "agent", "command", "skill"]);
    await expect(
      rpc.bind({ sessionID: "paseo", ...plugin.options, token: "another-daemon" }),
    ).resolves.toEqual({ error: "OpenCode session is already bound to another Paseo bridge" });
    const own = { sessionID: "paseo", tools: { paseo_echo: {}, native: {} }, system: [] };
    for (const hook of hooks) await hook(own);
    expect(Object.keys(own.tools)).toEqual(["paseo_echo", "native"]);
    expect(
      await installed.get("paseo_echo")!.execute({ value: "ok" }, { sessionID: "paseo" }),
    ).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    await dispose();
    hooks.length = 0;
    installed.clear();
    dispose = await module.default.setup(context);
    const afterReload = { sessionID: "paseo", tools: { paseo_echo: {}, native: {} }, system: [] };
    for (const hook of hooks) await hook(afterReload);
    expect(Object.keys(afterReload.tools)).toEqual(["paseo_echo", "native"]);
    expect(
      await installed.get("paseo_echo")!.execute({ value: "reloaded" }, { sessionID: "paseo" }),
    ).toMatchObject({ content: [{ type: "text", text: "reloaded" }] });
    await bridge.close();
    await dispose();
    hooks.length = 0;
    installed.clear();
    dispose = await module.default.setup(context);
    const unrelated = { sessionID: "other", tools: { paseo_echo: {}, native: {} }, system: [] };
    for (const hook of hooks) await hook(unrelated);
    expect(Object.keys(unrelated.tools)).toEqual(["native"]);
    structured = true;
    const structuredOnly = {
      sessionID: "other",
      tools: { paseo_structured_output: {} },
      system: [],
    };
    for (const hook of hooks) await hook(structuredOnly);
    expect(Object.keys(structuredOnly.tools)).toEqual(["paseo_structured_output"]);
    const restarted = new OpenCodeBridge({
      paseoHome: home,
      logger: createTestLogger(),
      port: Number(new URL(plugin.options.baseUrl).port),
    });
    restarted.setManifestCatalog({ tools });
    await restarted.start();
    const releaseRestarted = restarted.bindSession({ sessionId: "paseo", env: {} });
    try {
      await expect(
        rpc.bind({ sessionID: "paseo", ...restarted.sharedV2Connection() }),
      ).resolves.toEqual({});
    } finally {
      releaseRestarted();
      await restarted.close();
    }
    await dispose();
  } finally {
    unbind();
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  }
});
