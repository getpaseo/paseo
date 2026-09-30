import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pino from "pino";
import {
  builtinPlugins,
  resolveBuiltinPluginsRoot,
} from "../packages/server/dist/server/server/plugins/builtin/index.js";
import { compilePlugin } from "../packages/server/dist/server/server/plugins/compiler.js";
import { readPluginManifest } from "../packages/server/dist/server/server/plugins/manifest.js";
import { PluginRuntime } from "../packages/server/dist/server/server/plugins/runtime.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedRoot = path.join(repoRoot, "packages/server/dist/server/builtin-plugins");

async function findEntry(directory, names) {
  for (const name of names) {
    const entry = path.join(directory, name);
    if ((await stat(entry).catch(() => null))?.isFile()) return entry;
  }
  return null;
}

test("built output compiles and starts every listed built-in", async () => {
  assert.equal(resolveBuiltinPluginsRoot(), packagedRoot);
  assert.ok(!builtinPlugins.includes("antigravity-provider"));
  assert.ok(builtinPlugins.includes("muse-provider"));
  assert.equal(await stat(path.join(packagedRoot, "antigravity-provider")).catch(() => null), null);
  const { version } = JSON.parse(
    await readFile(path.join(repoRoot, "packages/server/package.json"), "utf8"),
  );
  const settingsDirectory = await mkdtemp(path.join(os.tmpdir(), "builtin-dist-settings-"));
  const runtime = new PluginRuntime(pino({ level: "silent" }), version, { settingsDirectory });
  runtime.bindPaseoSessionHost({
    async attachPluginSocket(_pluginId, socket) {
      const closed = new Promise((resolve) => socket.once("close", resolve));
      socket.on("message", (data) => {
        if (typeof data !== "string") return;
        const message = JSON.parse(data);
        if (message.type !== "hello") return;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "builtin-dist-test",
                hostname: "builtin-dist-test",
                version,
                features: {},
              },
            },
          }),
        );
      });
      return { closed };
    },
  });
  try {
    for (const id of builtinPlugins) {
      const directory = path.join(packagedRoot, id);
      assert.equal((await readPluginManifest(directory)).id, id);
      const bundles = await compilePlugin({
        server: await findEntry(directory, ["index.server.ts", "index.server.tsx"]),
        client: await findEntry(directory, ["index.client.ts", "index.client.tsx"]),
      });
      assert.ok(bundles.serverBundle, `${id} must compile a server bundle`);
      await runtime.startBuiltinPlugin({ id, directory });
      assert.ok(runtime.catalog().some((plugin) => plugin.id === id));
      if (id === "muse-provider") {
        assert.ok(runtime.getProviderRegistrations(id).some((provider) => provider.id === "muse"));
      }
      if (id.endsWith("-usage-source")) {
        const sourceId = id.slice(0, -"-usage-source".length);
        assert.ok(
          runtime.getUsageSourceRegistrations(id).some((source) => source.id === sourceId),
          `${id} must register usage source ${sourceId}`,
        );
      }
    }
  } finally {
    await runtime.stopAll();
    await rm(settingsDirectory, { recursive: true, force: true });
  }
});
