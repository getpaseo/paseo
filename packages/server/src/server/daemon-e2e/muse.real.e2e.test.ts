import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import { loadPersistedConfig } from "../persisted-config.js";
import { resolvePaseoHome } from "../paseo-home.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

test("Muse publishes its client settings bundle while installed plugins are disabled", async () => {
  const daemon = await createTestPaseoDaemon({
    builtinPlugins: new BuiltinPluginLoader(undefined, ["muse-provider"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.10.0",
  });
  try {
    await client.connect();
    const muse = (await client.getPluginCatalog()).find((plugin) => plugin.id === "muse-provider");
    expect(muse?.clientBundle).toBeTypeOf("string");
    expect(muse?.clientBundle).not.toBe("");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("Muse creates an agent, streams a text reply, and executes a real tool", async (context) => {
  if (!(await isCommandAvailable("muse"))) {
    context.skip();
    return;
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-muse-e2e-"));
  await writeFile(path.join(cwd, "f"), "MUSE_TOOL_E2E_OK\n");
  execFileSync("git", ["init", cwd], { stdio: "ignore" });
  const configured = loadPersistedConfig(resolvePaseoHome()).agents?.providers?.muse;
  const daemon = await createTestPaseoDaemon({
    builtinPlugins: new BuiltinPluginLoader(undefined, ["muse-provider"]),
    providerOverrides: { muse: { ...configured, enabled: true } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.10.0",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({ provider: "muse", cwd, modeId: "allowAll" });
    await client.sendMessage(agent.id, "Reply exactly MUSE_TEXT_E2E_OK. Do not use tools.");
    expect((await client.waitForFinish(agent.id, 120000)).status).toBe("idle");
    const reply = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(
      reply.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("MUSE_TEXT_E2E_OK"),
      ),
    ).toBe(true);
    await client.sendMessage(
      agent.id,
      "Read the file f with the read_file tool and report its contents.",
    );
    expect((await client.waitForFinish(agent.id, 120000)).status).toBe("idle");
    const tools = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(
      tools.entries.some(
        (entry) =>
          entry.item.type === "tool_call" &&
          entry.item.name === "read_file" &&
          entry.item.status === "completed",
      ),
    ).toBe(true);
    expect(
      tools.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("MUSE_TOOL_E2E_OK"),
      ),
    ).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 300000);
