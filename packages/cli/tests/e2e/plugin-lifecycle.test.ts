#!/usr/bin/env npx tsx
import { resolveCliVersion } from "../../src/version.js";
import { readPluginManifest } from "../../../server/src/server/plugins/manifest.js";

import {
  startNpmRegistry,
  npmPluginPackages,
} from "../../../../scripts/test-support/npm-registry.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { connectToDaemon } from "../../src/utils/client.ts";
import { createE2ETestContext } from "../helpers/test-daemon.ts";

const pluginSource = `export default function contribute(plugin: unknown) {
  void plugin;
  return () => undefined;
}`;

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

interface ObservedRequest {
  type: string;
  message: Record<string, unknown>;
  observedAt: number;
}

/**
 * Observes real CLI requests while forwarding them to the isolated daemon.
 *
 * Requests are recorded where the CLI sends them, so a scenario can measure a wait from the
 * request boundary instead of from process start.
 */
async function startRequestObserver(upstreamPort: number): Promise<{
  port: number;
  requests: ObservedRequest[];
  waitForRequest: (type: string) => Promise<number>;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests: ObservedRequest[] = [];
  server.on("connection", (socket, request) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${request.url}`, {
      headers: { authorization: request.headers.authorization ?? "" },
    });
    const ready = once(upstream, "open");
    socket.on("message", async (data, isBinary) => {
      const frame = JSON.parse(data.toString()) as {
        type?: string;
        message?: { type?: string } & Record<string, unknown>;
      };
      if (frame.type === "session" && typeof frame.message?.type === "string") {
        requests.push({
          type: frame.message.type,
          message: frame.message,
          observedAt: Date.now(),
        });
      }
      await ready;
      upstream.send(data, { binary: isBinary });
    });
    upstream.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    socket.on("close", () => upstream.close());
    upstream.on("close", () => socket.close());
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    requests,
    waitForRequest: async (type: string) => {
      await waitFor(
        async () => requests.some((entry) => entry.type === type),
        `${type} to reach the daemon`,
      );
      return requests.find((entry) => entry.type === type)!.observedAt;
    },
    close: async () => {
      for (const socket of server.clients) socket.close();
      await promisify(server.close.bind(server))();
    },
  };
}

/** Build command that blocks the plugin lifecycle queue until the test writes the gate file. */
const gateWaitBuild = [
  'const fs = require("node:fs");',
  'fs.writeFileSync(process.argv[1], "started");',
  "const wait = () => {",
  "  if (fs.existsSync(process.argv[2])) return;",
  "  setTimeout(wait, 50);",
  "};",
  "wait();",
].join("\n");

/** Plugin whose every activation appends one line, so a test can count real reactivations. */
function activationCountingPlugin(logPath: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    `const activationLog = ${JSON.stringify(logPath)};`,
    "export default function contribute(plugin: unknown) {",
    '  appendFileSync(activationLog, "activate\\n");',
    "  void plugin;",
    "  return () => undefined;",
    "}",
  ].join("\n");
}

async function countActivations(logPath: string): Promise<number> {
  const content = await readFile(logPath, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean).length;
}

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-cli-e2e-"));
  const gitDirectory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-git-cli-e2e-"));
  const registry = await startNpmRegistry(npmPluginPackages());
  const context = await createE2ETestContext({ timeout: 45_000, env: registry.env });
  try {
    const scaffold = path.join(context.workDir, "authored-plugin");
    const init = await context.paseo(["plugin", "init", scaffold, "--json"]);
    assert.equal(init.exitCode, 0, init.stderr);
    const manifestPath = path.join(scaffold, "paseo-plugin.json");
    const manifest = await readPluginManifest(scaffold);
    assert.deepEqual(manifest.requirements, { paseo: `>=${resolveCliVersion()}` });
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "cli-e2e", requirements: { paseo: `>=${resolveCliVersion()}` } }),
    );
    await writeFile(path.join(directory, "index.server.ts"), pluginSource);

    // Observe real CLI requests while forwarding them to the isolated daemon.
    const observer = await startRequestObserver(context.port);
    const installedSources = () =>
      observer.requests
        .filter((entry) => entry.type === "plugin.source.install.request")
        .map((entry) => entry.message.source);
    const sibling = path.join(context.workDir, "x");
    const caller = path.join(context.workDir, "caller");
    await mkdir(caller);
    await mkdir(path.join(sibling, "sub"), { recursive: true });
    for (const target of [caller, path.join(sibling, "sub"), context.paseoHome]) {
      await writeFile(
        path.join(target, "paseo-plugin.json"),
        JSON.stringify({
          id: "relative-cli",
          requirements: { paseo: `>=${resolveCliVersion()}` },
        }),
      );
      await writeFile(path.join(target, "index.server.ts"), pluginSource);
    }
    assert.notEqual(caller, process.cwd()); // The daemon inherits the test runner's cwd.
    try {
      for (const [source, expectedSource, expectedDirectory, extraArgs] of [
        [".", caller, caller, []],
        ["../x:sub", `${sibling}:sub`, path.join(sibling, "sub"), []],
        ["../x", `${sibling}:sub`, path.join(sibling, "sub"), ["--path", "sub"]],
        ["~", context.paseoHome, context.paseoHome, []],
        ["~/.:.", `${context.paseoHome}:.`, context.paseoHome, []],
      ] as const) {
        observer.requests.length = 0;
        const result = await context.paseo(
          ["plugin", "add", source, ...extraArgs, "--host", `127.0.0.1:${observer.port}`, "--json"],
          { cwd: caller },
        );
        assert.deepEqual(installedSources(), [expectedSource]);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).path, expectedDirectory);
        const removed = await context.paseo(["plugin", "remove", "relative-cli", "--json"]);
        assert.equal(removed.exitCode, 0, removed.stderr);
      }
      // An absolute path belongs to the daemon's platform, which can differ from the CLI's.
      const windowsSource = `C:\\${path.basename(context.workDir)}\\missing:sub`;
      observer.requests.length = 0;
      const missing = await context.paseo(
        ["plugin", "add", windowsSource, "--host", `127.0.0.1:${observer.port}`, "--json"],
        { cwd: caller },
      );
      assert.deepEqual(installedSources(), [windowsSource]);
      assert.equal(missing.exitCode, 1);
      assert.match(missing.stderr, /Plugin directory does not exist/);
    } finally {
      await observer.close();
    }

    const install = await context.paseo(["plugin", "install", directory, "--json"]);
    assert.equal(install.exitCode, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).id, "cli-e2e");

    const client = await connectToDaemon({
      target: { kind: "endpoint", host: `127.0.0.1:${context.port}` },
    });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.close();

    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, requirements: { paseo: ">=999.0.0" } }),
    );
    const incompatibleInstall = await context.paseo(["plugin", "install", scaffold, "--json"]);
    assert.equal(incompatibleInstall.exitCode, 1);
    assert.match(incompatibleInstall.stderr, /requires Paseo >=999.0.0/);
    const afterRejection = await context.paseo(["plugin", "ls", "--json"]);
    assert.equal(afterRejection.exitCode, 0, afterRejection.stderr);
    assert.deepEqual(
      JSON.parse(afterRejection.stdout).map((plugin: { id: string }) => plugin.id),
      ["cli-e2e"],
    );
    await writeFile(manifestPath, JSON.stringify(manifest));
    const scaffoldInstall = await context.paseo(["plugin", "install", scaffold, "--json"]);
    assert.equal(scaffoldInstall.exitCode, 0, scaffoldInstall.stderr);
    assert.equal(JSON.parse(scaffoldInstall.stdout).status, "running");

    await git(gitDirectory, ["init", "-b", "main"]);
    await git(gitDirectory, ["config", "user.name", "Paseo Tests"]);
    await git(gitDirectory, ["config", "user.email", "paseo@example.test"]);
    await writeFile(
      path.join(gitDirectory, "paseo-plugin.json"),
      JSON.stringify({ id: "git-cli-e2e", requirements: { paseo: `>=${resolveCliVersion()}` } }),
    );
    await writeFile(path.join(gitDirectory, "index.server.ts"), pluginSource);
    await git(gitDirectory, ["add", "-A"]);
    await git(gitDirectory, ["commit", "-m", "initial"]);

    const gitInstall = await context.paseo([
      "plugin",
      "add",
      `git:${pathToFileURL(gitDirectory).href}`,
      "--json",
    ]);
    assert.equal(gitInstall.exitCode, 0, gitInstall.stderr);
    assert.equal(JSON.parse(gitInstall.stdout).source, "git");

    await writeFile(
      path.join(gitDirectory, "index.server.ts"),
      `${pluginSource}\nconst updated = true;\n`,
    );
    await git(gitDirectory, ["add", "-A"]);
    await git(gitDirectory, ["commit", "-m", "update"]);
    const status = await context.paseo(["plugin", "status", "git-cli-e2e", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout)[0].status, "running");
    assert.equal(JSON.parse(status.stdout)[0].commit, JSON.parse(gitInstall.stdout).commit);

    const update = await context.paseo(["plugin", "update", "git-cli-e2e", "--yes", "--json"]);
    assert.equal(update.exitCode, 0, update.stderr);
    assert.equal(JSON.parse(update.stdout)[0].outcome, "updated");

    const installedCommit = JSON.parse(update.stdout)[0].plugin.installation.currentRevision;
    const buildMarker = path.join(context.workDir, "incompatible-build-ran");
    await writeFile(
      path.join(gitDirectory, "paseo-plugin.json"),
      JSON.stringify({
        id: "git-cli-e2e",
        requirements: { paseo: ">=999.0.0" },
        build: [
          [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], "ran")',
            buildMarker,
          ],
        ],
      }),
    );
    await git(gitDirectory, ["add", "-A"]);
    await git(gitDirectory, ["commit", "-m", "requires a future Paseo"]);
    const incompatibleUpdate = await context.paseo([
      "plugin",
      "update",
      "git-cli-e2e",
      "--yes",
      "--json",
    ]);
    assert.equal(incompatibleUpdate.exitCode, 1);
    assert.match(JSON.parse(incompatibleUpdate.stdout)[0].error, /requires Paseo >=999.0.0/);
    await assert.rejects(readFile(buildMarker), { code: "ENOENT" });
    const retained = await context.paseo(["plugin", "ls", "git-cli-e2e", "--json"]);
    assert.equal(retained.exitCode, 0, retained.stderr);
    assert.equal(JSON.parse(retained.stdout)[0].commit, installedCommit);
    assert.equal(JSON.parse(retained.stdout)[0].status, "running");
    const incompatibleAdd = await context.paseo([
      "plugin",
      "add",
      pathToFileURL(gitDirectory).href,
      "--id",
      "future-plugin",
      "--json",
    ]);
    assert.equal(incompatibleAdd.exitCode, 1);
    assert.match(incompatibleAdd.stderr, /requires Paseo >=999.0.0/);
    await assert.rejects(readFile(buildMarker), { code: "ENOENT" });

    const reload = await context.paseo(["plugin", "reload", "cli-e2e", "--json"]);
    assert.equal(reload.exitCode, 0, reload.stderr);
    assert.equal(JSON.parse(reload.stdout).status, "running");

    const disable = await context.paseo(["plugin", "disable", "cli-e2e", "--json"]);
    assert.equal(disable.exitCode, 0, disable.stderr);
    assert.equal(JSON.parse(disable.stdout).status, "disabled");

    const enable = await context.paseo(["plugin", "enable", "cli-e2e", "--json"]);
    assert.equal(enable.exitCode, 0, enable.stderr);
    assert.equal(JSON.parse(enable.stdout).status, "running");

    // A reload that finishes after the client's former one-minute deadline must still report its
    // real result. The wait is the daemon's own lifecycle queue, so it runs on real wall-clock time.
    const gateDirectory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-reload-e2e-"));
    const buildStarted = path.join(gateDirectory, "build-started");
    const buildGate = path.join(gateDirectory, "build-gate");
    const activationLog = path.join(gateDirectory, "activations.log");
    const targetDirectory = path.join(gateDirectory, "slow-reload-target");
    const slowRepository = path.join(gateDirectory, "slow-build");
    const reloadObserver = await startRequestObserver(context.port);
    let slowInstall: ReturnType<typeof context.paseo> | undefined;
    let slowReload: ReturnType<typeof context.paseo> | undefined;
    try {
      await mkdir(targetDirectory);
      await writeFile(
        path.join(targetDirectory, "paseo-plugin.json"),
        JSON.stringify({
          id: "slow-reload-target",
          requirements: { paseo: `>=${resolveCliVersion()}` },
        }),
      );
      await writeFile(
        path.join(targetDirectory, "index.server.ts"),
        activationCountingPlugin(activationLog),
      );
      const targetInstall = await context.paseo(["plugin", "install", targetDirectory, "--json"]);
      assert.equal(targetInstall.exitCode, 0, targetInstall.stderr);
      assert.equal(await countActivations(activationLog), 1);

      await mkdir(slowRepository);
      await git(slowRepository, ["init", "-b", "main"]);
      await git(slowRepository, ["config", "user.name", "Paseo Tests"]);
      await git(slowRepository, ["config", "user.email", "paseo@example.test"]);
      await writeFile(
        path.join(slowRepository, "paseo-plugin.json"),
        JSON.stringify({
          id: "slow-build",
          requirements: { paseo: `>=${resolveCliVersion()}` },
          build: [[process.execPath, "-e", gateWaitBuild, buildStarted, buildGate]],
        }),
      );
      await writeFile(path.join(slowRepository, "index.server.ts"), pluginSource);
      await git(slowRepository, ["add", "-A"]);
      await git(slowRepository, ["commit", "-m", "blocking build"]);

      // This install holds the plugin lifecycle queue while its build waits for the gate.
      slowInstall = context.paseo(
        ["plugin", "add", `git:${pathToFileURL(slowRepository).href}`, "--json"],
        { timeout: 180_000 },
      );
      await waitFor(
        async () =>
          readFile(buildStarted, "utf8").then(
            () => true,
            () => false,
          ),
        "the blocking build to start",
      );

      slowReload = context.paseo(
        [
          "plugin",
          "reload",
          "slow-reload-target",
          "--host",
          `127.0.0.1:${reloadObserver.port}`,
          "--json",
        ],
        { timeout: 180_000 },
      );
      const reloadRequestedAt = await reloadObserver.waitForRequest("plugin.reload.request");

      // The interim listing is not the reload's outcome: it still reports the plugin running and
      // no restart has happened while the reload waits behind the queue.
      const duringReload = await context.paseo(["plugin", "ls", "slow-reload-target", "--json"]);
      assert.equal(duringReload.exitCode, 0, duringReload.stderr);
      assert.equal(JSON.parse(duringReload.stdout)[0].status, "running");
      assert.equal(await countActivations(activationLog), 1);

      const heldMs = Date.now() - reloadRequestedAt;
      if (heldMs < 66_000) {
        await sleep(66_000 - heldMs);
      }
      await writeFile(buildGate, "go");

      const [buildResult, reloadResult] = await Promise.all([slowInstall, slowReload]);
      assert.equal(buildResult.exitCode, 0, buildResult.stderr);
      assert.equal(reloadResult.exitCode, 0, reloadResult.stderr);
      assert.equal(JSON.parse(reloadResult.stdout).status, "running");
      assert.equal(await countActivations(activationLog), 2);

      // A plugin that cannot start still fails its reload with the daemon's error.
      const brokenDirectory = path.join(gateDirectory, "broken-plugin");
      await mkdir(brokenDirectory);
      await writeFile(
        path.join(brokenDirectory, "paseo-plugin.json"),
        JSON.stringify({
          id: "broken-reload",
          requirements: { paseo: `>=${resolveCliVersion()}` },
        }),
      );
      await writeFile(path.join(brokenDirectory, "index.server.ts"), "export default broken !!!");
      const brokenInstall = await context.paseo(["plugin", "install", brokenDirectory, "--json"]);
      assert.equal(brokenInstall.exitCode, 1);
      assert.match(brokenInstall.stderr, /broken-reload|broken|failed/i);
      const brokenReload = await context.paseo(["plugin", "reload", "broken-reload", "--json"], {
        timeout: 60_000,
      });
      assert.equal(brokenReload.exitCode, 1);
      assert.match(brokenReload.stderr, /broken-reload|broken|failed/i);

      for (const pluginId of ["slow-reload-target", "slow-build", "broken-reload"]) {
        const removed = await context.paseo(["plugin", "remove", pluginId, "--json"]);
        assert.equal(removed.exitCode, 0, removed.stderr);
      }
    } finally {
      // Release the gate, then let the install and the reload settle before their files go: the
      // build polls for the gate file, so cleanup must not delete it while the child still waits.
      await writeFile(buildGate, "go").catch(() => undefined);
      await Promise.all([slowInstall?.catch(() => undefined), slowReload?.catch(() => undefined)]);
      await reloadObserver.close();
      await rm(gateDirectory, { recursive: true, force: true });
    }

    const remove = await context.paseo(["plugin", "remove", "cli-e2e", "--json"]);
    assert.equal(remove.exitCode, 0, remove.stderr);
    const removeGit = await context.paseo(["plugin", "remove", "git-cli-e2e", "--json"]);
    assert.equal(removeGit.exitCode, 0, removeGit.stderr);
    const removeScaffold = await context.paseo(["plugin", "remove", "authored-plugin", "--json"]);
    assert.equal(removeScaffold.exitCode, 0, removeScaffold.stderr);
    for (const source of ["npm:paseo-fixture-plugin@^1.0.0", "npm:@paseo-fixture/review@2.0.0"]) {
      const npmInstall = await context.paseo([
        "plugin",
        "install",
        source,
        "--path",
        ".",
        "--json",
      ]);
      assert.equal(npmInstall.exitCode, 0, npmInstall.stderr);
      assert.equal(JSON.parse(npmInstall.stdout).id, "npm-review");
      assert.equal(JSON.parse(npmInstall.stdout).status, "running");
      assert.equal(
        JSON.parse(npmInstall.stdout).installation.currentRevision,
        source.includes("@paseo-fixture") ? "2.0.0" : "1.1.0",
      );
      const npmDisabled = await context.paseo(["plugin", "disable", "npm-review", "--json"]);
      assert.equal(npmDisabled.exitCode, 0, npmDisabled.stderr);
      const restart = await context.paseo(["daemon", "restart", "--timeout", "45", "--json"], {
        timeout: 60_000,
      });
      assert.equal(restart.exitCode, 0, restart.stderr);
      assert.notEqual(
        JSON.parse(restart.stdout).workerPid,
        JSON.parse(restart.stdout).previousWorkerPid,
      );
      const persisted = await context.paseo(["plugin", "ls", "npm-review", "--json"]);
      assert.equal(persisted.exitCode, 0, persisted.stderr);
      assert.equal(JSON.parse(persisted.stdout)[0].status, "disabled");
      assert.equal(JSON.parse(persisted.stdout)[0].path, JSON.parse(npmInstall.stdout).path);
      assert.deepEqual(
        JSON.parse(persisted.stdout)[0].installation,
        JSON.parse(npmInstall.stdout).installation,
      );
      const npmEnabled = await context.paseo(["plugin", "enable", "npm-review", "--json"]);
      assert.equal(npmEnabled.exitCode, 0, npmEnabled.stderr);
      assert.equal(JSON.parse(npmEnabled.stdout).status, "running");
      const npmReload = await context.paseo(["plugin", "reload", "npm-review", "--json"]);
      assert.equal(npmReload.exitCode, 0, npmReload.stderr);
      const npmRemove = await context.paseo(["plugin", "remove", "npm-review", "--json"]);
      assert.equal(npmRemove.exitCode, 0, npmRemove.stderr);
    }
    const list = await context.paseo(["plugin", "ls", "--json"]);
    assert.equal(list.exitCode, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), []);
  } finally {
    await context.stop();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
    await rm(gitDirectory, { recursive: true, force: true });
  }
}

await main();
