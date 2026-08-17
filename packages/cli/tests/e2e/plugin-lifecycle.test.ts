#!/usr/bin/env npx tsx

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectToDaemon } from "../../src/utils/client.ts";
import { createE2ETestContext } from "../helpers/test-daemon.ts";

const pluginSource = `export default function contribute(plugin: unknown) {
  void plugin;
  return () => undefined;
}`;

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-cli-e2e-"));
  const context = await createE2ETestContext({ timeout: 45_000 });
  try {
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "cli-e2e" }));
    await writeFile(path.join(directory, "index.tsx"), pluginSource);

    const install = await context.paseo(["plugin", "install", directory, "--json"]);
    assert.equal(install.exitCode, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).id, "cli-e2e");

    const client = await connectToDaemon({ host: `127.0.0.1:${context.port}` });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.close();

    const reload = await context.paseo(["plugin", "reload", "cli-e2e", "--json"]);
    assert.equal(reload.exitCode, 0, reload.stderr);
    assert.equal(JSON.parse(reload.stdout).status, "running");

    const disable = await context.paseo(["plugin", "disable", "cli-e2e", "--json"]);
    assert.equal(disable.exitCode, 0, disable.stderr);
    assert.equal(JSON.parse(disable.stdout).status, "disabled");

    const enable = await context.paseo(["plugin", "enable", "cli-e2e", "--json"]);
    assert.equal(enable.exitCode, 0, enable.stderr);
    assert.equal(JSON.parse(enable.stdout).status, "running");

    const remove = await context.paseo(["plugin", "remove", "cli-e2e", "--json"]);
    assert.equal(remove.exitCode, 0, remove.stderr);
    const list = await context.paseo(["plugin", "ls", "--json"]);
    assert.equal(list.exitCode, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), []);
  } finally {
    await context.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
