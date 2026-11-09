import { measureMainThreadWork } from "../../../test-utils/main-thread-work.js";
import assert from "node:assert/strict";
import { open as openFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { PluginService } from "../index.js";

// A fresh process excludes the E2E harness's transform/bootstrap garbage from
// the compiler measurement. All work and dependencies below are real.
const directory = process.argv[2];
assert.ok(directory, "Fixture directory is required");
const results: { blockingMs: number }[] = [];
await writeFile(
  path.join(directory, "paseo-plugin.json"),
  JSON.stringify({ id: "responsive-build" }),
);
// Erased types stress TypeScript's AST walk without a multi-MiB runtime bundle.
// Payload transfer is a different cost from import validation.
const entryFile = await openFile(path.join(directory, "index.client.ts"), "w");
try {
  await entryFile.write("type FixtureValues = [");
  for (let offset = 0; offset < 350_000; offset += 10_000) {
    await entryFile.write(
      Array.from({ length: 10_000 }, (_, index) => offset + index).join(",") + ",",
    );
  }
  await entryFile.write(
    ']; export default function contribute() { return () => "compiled fixture"; }',
  );
} finally {
  await entryFile.close();
}
const store = new DaemonConfigStore(directory, {
  mcp: { injectIntoAgents: true },
  browserTools: { enabled: false },
  providers: {},
  metadataGeneration: { providers: [] },
  autoArchiveAfterMerge: false,
  enableTerminalAgentHooks: false,
  appendSystemPrompt: "",
  pluginsEnabled: true,
  plugins: {
    "responsive-build": { source: "directory", path: directory, enabled: false },
  },
});
const service = new PluginService(pino({ level: "silent" }), store, "0.4.0");
await service.start();
try {
  for (const action of [
    () => service.enablePlugin("responsive-build"),
    () => service.reloadPlugin("responsive-build"),
  ]) {
    const { blockingMs } = await measureMainThreadWork("plugin compile main-thread work", action);
    assert.ok(service.catalog()[0]?.clientBundle.includes("compiled fixture"));
    results.push({ blockingMs });
  }
  // Evaluate after both probes so parsing the returned code is not charged to compilation.
  const factory = globalThis.eval(service.catalog()[0]!.clientBundle) as (
    require: (specifier: string) => never,
  ) => { default: () => () => string };
  const result = factory((specifier) => {
    throw new Error(`Unexpected fixture dependency: ${specifier}`);
  }).default()();
  assert.equal(result, "compiled fixture");
} finally {
  await service.stopAllPlugins();
}
process.stdout.write(JSON.stringify(results));
