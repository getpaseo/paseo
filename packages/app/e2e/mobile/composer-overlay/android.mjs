// Start on a completed conversation in the connected Android dev client.
// node android.mjs <session> <daemon-ws-url> <workspace-id> <agent-id> [app-id] [metro-port]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DaemonClient } from "../../../../client/dist/daemon-client.js";

const [, , session, daemonUrl, workspaceId, agentId, appId = "sh.paseo.debug", metroPort = "8081"] =
  process.argv;
assert(
  session && daemonUrl && workspaceId && agentId,
  "Pass a session, isolated daemon URL, workspace ID, and agent ID",
);
const url = new URL(daemonUrl);
assert(["127.0.0.1", "localhost"].includes(url.hostname), "Use an isolated loopback daemon");
assert(!["", "6767", "6768"].includes(url.port), "Do not use the installed or development daemon");
const directory = await mkdtemp(path.join(tmpdir(), "paseo-composer-overlay-"));
const artifacts = process.env.PASEO_OVERLAY_ARTIFACTS_DIR ?? path.join(directory, "evidence");
await mkdir(artifacts, { recursive: true });
const pluginId = "composer-overlay-mobile-repro";
const pillLabel = "Overlay regression pill";
const client = new DaemonClient({
  url: daemonUrl,
  clientId: "composer-overlay-mobile-regression",
  clientType: "cli",
  appVersion: JSON.parse(await readFile(new URL("../../../package.json", import.meta.url))).version,
  webSocketFactory: (address, options) => new WebSocket(address, options),
});
function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    encoding: "utf8",
    timeout: 90_000,
  });
}
let installed = false;
let previousConfig;
try {
  ad("wait", 'label="Copy turn"', "20000");
  await client.connect();
  previousConfig = (await client.getDaemonConfig()).config;
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: pluginId,
      requirements: { paseo: ">=0.11.4" },
    }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `export default function contribute(client) {
    let pill;
    const timer = setTimeout(() => {
      pill = client.addComposerPill({
        id: "late-pill", workspaceId: ${JSON.stringify(workspaceId)}, agentId: ${JSON.stringify(agentId)},
        button: { title: ${JSON.stringify(pillLabel)}, icon: "Clock", behavior: { kind: "action", onPress() {} } },
      });
    }, 5000);
    return () => { clearTimeout(timer); pill?.remove(); };
  }`,
  );
  await client.installDirectoryPlugin(directory);
  installed = true;
  ad("wait", `label="${pillLabel}"`, "20000");
  // Match the report: reopen a completed conversation, then let the plugin register late.
  ad(
    "open",
    appId,
    "--platform",
    "android",
    "--metro-port",
    metroPort,
    "--no-test-ime",
    "--relaunch",
  );
  ad("wait", `label="${pillLabel}"`, "20000");
  const capture = path.join(artifacts, "cold-reopen.json");
  await writeFile(capture, ad("snapshot", "--raw", "--json"));
  ad("screenshot", path.join(artifacts, "cold-reopen.png"));
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./assert-footer-clear.mjs", import.meta.url)), capture, pillLabel],
    { stdio: "inherit" },
  );
} finally {
  if (installed) await client.removePlugin(pluginId);
  if (previousConfig)
    await client.patchDaemonConfig({ pluginsEnabled: previousConfig.pluginsEnabled });
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
