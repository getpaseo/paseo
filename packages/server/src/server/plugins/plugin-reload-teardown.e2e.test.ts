import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

// The direct provider example, with a close() that does real asynchronous work
// the way a provider holding a live agent does.
async function createSlowClosingProviderPlugin(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-slow-close-plugin-"));
  await cp(path.join(repoRoot, "plugin-examples/provider-direct"), directory, { recursive: true });
  const providerPath = path.join(directory, "server", "provider.ts");
  const source = (await readFile(providerPath, "utf8")).replaceAll("\r\n", "\n");
  const patched = source.replace(
    "      closed = true;\n      sessions.clear();",
    "      closed = true;\n      await new Promise((resolve) => setTimeout(resolve, 250));\n      sessions.clear();",
  );
  expect(patched).not.toBe(source);
  await writeFile(providerPath, patched);
  return directory;
}

test("reloading a plugin does not send on a closed IPC channel", async () => {
  const pluginDirectory = await createSlowClosingProviderPlugin();
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-reload-teardown-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const agent = await client.createAgent({ provider: "direct-example", cwd });
    // A turn in flight keeps the provider connection busy, so the reload's
    // connection close is still running when the subprocess tears down.
    const turn = client.sendMessage(agent.id, "Say hello").catch(() => undefined);
    await client.reloadPlugin("provider-direct-example");
    const entries = await client.getPluginLogs("provider-direct-example");
    const messages = entries.map((entry) => entry.message).join("\n");
    expect(messages).not.toContain("ERR_IPC_CHANNEL_CLOSED");
    await turn;
    await client.archiveAgent(agent.id).catch(() => undefined);
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}, 60_000);
