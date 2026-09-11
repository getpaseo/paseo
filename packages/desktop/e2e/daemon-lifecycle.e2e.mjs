import { verifyAttachedDaemonControls } from "./daemon-lifecycle-renderer.electron.mjs";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import {
  savePersistedConfig,
  startDaemonInstance,
  stopDaemonInstance,
  readDaemonInstance,
} from "@getpaseo/server";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "paseo desktop lifecycle "));
const home = path.join(root, "daemon");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("PASEO_") && key !== "ELECTRON_RUN_AS_NODE",
  ),
);
env.HOME = root;
env.USERPROFILE = root;
env.PASEO_HOME = home;
const server = net.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
assert.ok(port !== 6767 && port !== 6768);
await mkdir(path.join(root, "web"));
await writeFile(path.join(root, "web/index.html"), "<html><body>Lifecycle web UI</body></html>");
savePersistedConfig(home, {
  daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } },
  features: {
    dictation: { enabled: false },
    voiceMode: { enabled: false },
    webUi: { enabled: true, distDir: path.join(root, "web") },
  },
});
const main = path.join(root, "main.cjs");
const managerPath = path.join(repo, "packages/desktop/dist/daemon/daemon-manager.js");
await writeFile(
  main,
  `const { app } = require("electron"); app.setPath("userData", ${JSON.stringify(path.join(root, "user-data"))}); app.whenReady().then(() => { global.lifecycle = require(${JSON.stringify(managerPath)}); });`,
);
let desktop;
let captured;
async function openDesktop() {
  desktop = await electron.launch({
    args: ["--no-sandbox", "--ozone-platform=headless", main],
    env: {
      ...env,
      PASEO_LISTEN: "127.0.0.1:1",
      PASEO_WEB_UI_ENABLED: "false",
      PASEO_HOST: "unused:1",
    },
  });
  await expect
    .poll(() => desktop.evaluate(() => Boolean(global.lifecycle)), { timeout: 10_000 })
    .toBe(true);
}
async function closeDesktop() {
  if (!desktop) return;
  const child = desktop.process();
  const exited = once(child, "exit");
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await exited;
  desktop = null;
}
async function command(name, args) {
  console.log(`Desktop command: ${name}${args?.reason ? ` (${args.reason})` : ""}`);
  return desktop.evaluate(
    async (_, input) => global.lifecycle.createDaemonCommandHandlers()[input.name](input.args),
    { name, args },
  );
}
try {
  // Simulate a legacy independent launch that carries the old Desktop flag.
  const launch = await startDaemonInstance({
    home,
    command: process.execPath,
    args: [path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js")],
    env,
    mode: "deployment",
    desktopManaged: true,
    timeoutMs: 30_000,
  });
  captured = launch.instance;
  await openDesktop();
  const attached = await command("start_desktop_daemon");
  assert.equal(attached.pid, captured.pid);
  assert.equal(attached.desktopManaged, true);
  assert.equal(attached.ownedByDesktop, false);
  for (const reason of ["quit", "settings", "app_update", "host_remove", "version_mismatch"]) {
    const status = await command("stop_desktop_daemon", { reason });
    assert.equal(status.pid, captured.pid, `${reason} stopped an attached daemon`);
    process.kill(captured.pid, 0);
  }
  const restarted = await command("restart_desktop_daemon");
  assert.equal(restarted.pid, captured.pid);
  await assert.rejects(
    command("stop_desktop_daemon", {
      reason: "manual_ipc",
      pid: captured.pid,
      startedAt: "outdated-confirmation",
    }),
    /changed since confirmation/,
  );
  const stopped = await command("stop_desktop_daemon", {
    reason: "manual_ipc",
    pid: captured.pid,
    startedAt: captured.startedAt,
  });
  assert.equal(stopped.status, "stopped");
  captured = null;

  const owned = await command("start_desktop_daemon");
  captured = await readDaemonInstance(home);
  assert.equal(owned.pid, captured.pid);
  assert.equal(owned.ownedByDesktop, true);
  assert.equal(owned.listen, `127.0.0.1:${port}`);
  assert.equal(
    JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).features.webUi.enabled,
    true,
  );
  const liveWebUi = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(liveWebUi.status, 200);
  assert.match(await liveWebUi.text(), /Lifecycle web UI/);
  await command("patch_desktop_settings", { daemon: { keepRunningAfterQuit: true } });
  await closeDesktop();
  desktop = null;
  process.kill(captured.pid, 0);
  await openDesktop();
  assert.equal((await command("start_desktop_daemon")).ownedByDesktop, false);
  await command("stop_desktop_daemon", { reason: "quit" });
  process.kill(captured.pid, 0);
  await command("stop_desktop_daemon", {
    reason: "manual_ipc",
    pid: captured.pid,
    startedAt: captured.startedAt,
  });
  captured = null;
  const next = await command("start_desktop_daemon");
  captured = await readDaemonInstance(home);
  assert.equal(next.ownedByDesktop, true);
  await command("stop_desktop_daemon", { reason: "quit" });
  assert.equal(await readDaemonInstance(home), null);
  captured = null;
  await closeDesktop();
  if (process.platform === "linux") {
    const rendererLaunch = await startDaemonInstance({
      home,
      command: process.execPath,
      args: [path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js")],
      env,
      mode: "deployment",
      desktopManaged: true,
      timeoutMs: 30_000,
    });
    captured = rendererLaunch.instance;
    await verifyAttachedDaemonControls({ repo, root, env, home, port, instance: captured });
    captured = null;
  }
  if (process.platform !== "win32") {
    const preload = path.join(root, "slow-worker.mjs");
    await writeFile(
      preload,
      'if (process.argv[1]?.endsWith("daemon-worker.js")) await new Promise(resolve => setTimeout(resolve, 45000));',
    );
    await openDesktop();
    // Playwright removes NODE_OPTIONS from electron.launch's environment.
    // Restore this runtime input inside the isolated fixture before it launches the daemon.
    await desktop.evaluate(
      (_, value) => {
        process.env.NODE_OPTIONS = value;
      },
      `--import=${pathToFileURL(preload).href}`,
    );
    const began = Date.now();
    const starting = await command("start_desktop_daemon");
    captured = await readDaemonInstance(home);
    assert.equal(starting.status, "starting");
    assert.equal(starting.ownedByDesktop, true);
    assert.equal(starting.pid, captured.pid);
    assert.ok(Date.now() - began < 40_000, "Desktop did not return its bounded starting state");
    process.kill(captured.pid, 0);
    await command("stop_desktop_daemon", { reason: "quit" });
    captured = null;
    await closeDesktop();
    console.log(
      "PASS: Desktop readiness deadline returns starting and preserves its owned slow launch.",
    );
  }
  console.log(
    "PASS: attached legacy daemon survives automatic actions; explicit captured stop, owned launch, managed settings, worker restart, and next-session attachment.",
  );
} finally {
  await closeDesktop();
  if (captured)
    await stopDaemonInstance(home, { instance: captured, force: true, timeoutMs: 2_000 });
  const artifacts =
    process.env.PASEO_DESKTOP_LIFECYCLE_ARTIFACT_DIR ??
    (await mkdtemp(path.join(tmpdir(), "paseo-desktop-lifecycle-artifacts-")));
  await mkdir(artifacts, { recursive: true });
  for (const name of await readdir(root))
    if (name.endsWith(".png")) await copyFile(path.join(root, name), path.join(artifacts, name));
  await rm(root, { recursive: true, force: true });
  console.log(`Lifecycle artifacts: ${artifacts}`);
}
