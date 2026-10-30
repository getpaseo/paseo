import path from "node:path";
import { initializeEnvironmentProxy } from "../../network/index.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, resolveBuiltinPluginsRoot } from "../builtin/index.js";

const mode = process.argv[2];
if (mode !== "builtin" && mode !== "directory") throw new Error("Expected builtin or directory");
const sources = ["claude-usage-source", "codex-usage-source"];
// Built-ins run inside the daemon; directory plugins initialize their own subprocess network.
if (mode === "builtin") initializeEnvironmentProxy();
const daemon = await createTestPaseoDaemon({
  pluginsEnabled: mode === "directory",
  builtinPlugins: new BuiltinPluginLoader(
    resolveBuiltinPluginsRoot(),
    mode === "builtin" ? sources : [],
  ),
});
const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
try {
  await client.connect();
  if (mode === "directory") {
    for (const source of sources) {
      await client.installDirectoryPlugin(path.join(resolveBuiltinPluginsRoot(), source), source);
    }
  }
  await client.listUsageReports();
} finally {
  await client.close();
  await daemon.close();
}
