import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { createClientChannel } from "@getpaseo/relay/e2ee";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const desktopRoot = path.join(repoRoot, "packages", "desktop");
const relayRoot = path.join(repoRoot, "packages", "relay");
const desktopPackageJson = JSON.parse(
  await fs.readFile(path.join(desktopRoot, "package.json"), "utf8")
);
const currentRuntimeVersion = desktopPackageJson.version;
const currentRuntimePointer = JSON.parse(
  await fs.readFile(
    path.join(desktopRoot, "src-tauri", "resources", "managed-runtime", "current-runtime.json"),
    "utf8"
  )
);
const currentRuntimeId = currentRuntimePointer.runtimeId;

function resolvePackagedBinary() {
  const targetRoot = process.env.PASEO_MANAGED_SMOKE_RUST_TARGET
    ? path.join(
        desktopRoot,
        "src-tauri",
        "target",
        process.env.PASEO_MANAGED_SMOKE_RUST_TARGET,
        "release"
      )
    : path.join(desktopRoot, "src-tauri", "target", "release");
  if (process.platform === "darwin") {
    return path.join(
      targetRoot,
      "bundle",
      "macos",
      "Paseo.app",
      "Contents",
      "MacOS",
      "Paseo"
    );
  }
  if (process.platform === "linux") {
    return path.join(
      targetRoot,
      "bundle",
      "appimage",
      `Paseo_${desktopPackageJson.version}_amd64.AppImage`
    );
  }
  if (process.platform === "win32") {
    return path.join(
      targetRoot,
      "Paseo.exe"
    );
  }
  throw new Error(`Managed desktop smoke is not implemented for ${process.platform} yet.`);
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function snapshotTree(root) {
  if (!(await pathExists(root))) {
    return [];
  }
  const entries = [];
  async function walk(current) {
    const stat = await fs.stat(current);
    const relative = path.relative(root, current) || ".";
    entries.push({
      relative,
      kind: stat.isDirectory() ? "dir" : "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    if (!stat.isDirectory()) {
      return;
    }
    const children = await fs.readdir(current);
    children.sort();
    for (const child of children) {
      await walk(path.join(current, child));
    }
  }
  await walk(root);
  entries.sort((left, right) => left.relative.localeCompare(right.relative));
  return entries;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function execFileWithTimeout(command, args, options, label) {
  try {
    return await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      ...options,
    });
  } catch (error) {
    if (error?.killed && error?.signal === "SIGTERM") {
      const renderedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
      throw new Error(
        `Timed out after ${COMMAND_TIMEOUT_MS}ms running ${label}: ${JSON.stringify(command)} ${renderedArgs}`
      );
    }
    throw error;
  }
}

async function runBinary(binaryPath, args, env) {
  const { stdout, stderr } = await execFileWithTimeout(binaryPath, args, {
    env,
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  }, "packaged desktop binary");
  const trimmed = stdout.trim();
  return {
    stdout,
    stderr,
    json: trimmed ? JSON.parse(trimmed) : null,
  };
}

async function terminateChildProcess(child, label) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      await execFileWithTimeout(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { maxBuffer: 1024 * 1024 },
        `${label} taskkill`
      );
    } catch {}
    await waitForChildExit(child, 5_000);
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  await waitForChildExit(child, 5_000);
  if (child.exitCode === null && !child.killed) {
    try {
      child.kill("SIGKILL");
    } catch {}
    await waitForChildExit(child, 5_000);
  }
}

async function runWorkspaceCli(args, env) {
  const { stdout, stderr } = await execFileWithTimeout(
    process.execPath,
    [path.join(repoRoot, "packages", "cli", "dist", "index.js"), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
    "workspace CLI"
  );
  let json = null;
  if (stdout.trim()) {
    try {
      json = JSON.parse(stdout.trim());
    } catch {
      json = null;
    }
  }
  return { stdout, stderr, json };
}

async function runBundledRuntimeCli(runtimeRoot, managedHome, args, env) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(runtimeRoot, "runtime-manifest.json"), "utf8")
  );
  const { stdout, stderr } = await execFileWithTimeout(
    path.join(runtimeRoot, manifest.nodeRelativePath),
    [path.join(runtimeRoot, manifest.cliEntrypointRelativePath), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        PASEO_HOME: managedHome,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
    "bundled runtime CLI"
  );
  return { stdout, stderr };
}

async function readDaemonStatus(home, env) {
  const result = await runWorkspaceCli(["daemon", "status", "--home", home, "--json"], env);
  return result.json ?? {};
}

async function pidListeningOnPort(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`], {
      maxBuffer: 1024 * 1024,
    });
    const pid = Number.parseInt(stdout.trim().split("\n")[0] ?? "", 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate an ephemeral test port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function buildRelayWebSocketUrl({ endpoint, serverId, role }) {
  const url = new URL(`ws://${endpoint}/ws`);
  url.searchParams.set("serverId", serverId);
  url.searchParams.set("role", role);
  url.searchParams.set("v", "2");
  return url.toString();
}

function parseOfferUrlFromCommandOutput(stdout) {
  const match = stdout.match(/https?:\/\/\S+#offer=\S+/);
  if (!match) {
    throw new Error(`Failed to find pairing URL in output: ${stdout}`);
  }
  return match[0];
}

function decodeOfferFromFragmentUrl(url) {
  const marker = "#offer=";
  const index = url.indexOf(marker);
  if (index === -1) {
    throw new Error(`Pairing URL is missing ${marker}: ${url}`);
  }
  const encoded = url.slice(index + marker.length);
  const raw = Buffer.from(encoded, "base64url").toString("utf8");
  const offer = JSON.parse(raw);
  if (offer?.v !== 2 || typeof offer?.serverId !== "string" || typeof offer?.daemonPublicKeyB64 !== "string") {
    throw new Error(`Unexpected relay offer payload: ${raw}`);
  }
  return offer;
}

async function waitForRelayWebSocketReady(endpoint, timeoutMs) {
  await waitFor(async () => {
    const probeServerId = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const url = buildRelayWebSocketUrl({
      endpoint,
      serverId: probeServerId,
      role: "server",
    });
    const opened = await new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 5_000);
      ws.once("open", () => {
        clearTimeout(timer);
        ws.close(1000, "probe");
        resolve(true);
      });
      ws.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    assert.equal(opened, true);
  }, timeoutMs, "relay websocket endpoint to accept connections");
}

async function connectViaRelay(endpoint, offer) {
  const stableClientId = `cid-managed-smoke-${Date.now().toString(36)}`;
  const ws = new WebSocket(
    buildRelayWebSocketUrl({
      endpoint,
      serverId: offer.serverId,
      role: "client",
    })
  );
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for managed relay pong."));
    }, 20_000);

    const transport = {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      onmessage: null,
      onclose: null,
      onerror: null,
    };

    ws.on("message", (data) => {
      transport.onmessage?.(typeof data === "string" ? data : data.toString());
    });
    ws.on("close", (code, reason) => {
      transport.onclose?.(code, reason.toString());
    });
    ws.on("error", (error) => {
      transport.onerror?.(error);
    });

    ws.on("open", async () => {
      try {
        let pingSent = false;
        let channelRef = null;
        const channel = await createClientChannel(transport, offer.daemonPublicKeyB64, {
          onmessage: (data) => {
            try {
              const payload = typeof data === "string" ? JSON.parse(data) : data;
              if (payload?.type === "welcome") {
                if (!pingSent && channelRef) {
                  pingSent = true;
                  void channelRef.send(JSON.stringify({ type: "ping" }));
                }
                return;
              }
              if (payload?.type === "pong") {
                clearTimeout(timeout);
                resolve(payload);
                ws.close();
              }
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          },
          onerror: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        channelRef = channel;
        await channel.send(
          JSON.stringify({
            type: "hello",
            clientId: stableClientId,
            clientType: "cli",
            protocolVersion: 1,
          })
        );
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function assertNoForbiddenPathsOrPorts(value, forbidden) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  for (const candidate of forbidden) {
    assert.ok(
      !text.includes(candidate),
      `Unexpected forbidden managed smoke reference: ${candidate}`
    );
  }
}

async function ensurePackagedArtifact(binaryPath) {
  if (process.env.PASEO_MANAGED_SMOKE_SKIP_BUILD === "1") {
    return;
  }
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("npm_execpath is required to build the packaged desktop artifact during smoke tests.");
  }
  try {
    await execFileWithTimeout(process.execPath, [npmExecPath, "run", "build"], {
      cwd: desktopRoot,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    }, "desktop smoke artifact build");
  } catch (error) {
    const combined = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const signingBlocked =
      combined.includes("TAURI_SIGNING_PRIVATE_KEY") &&
      (await pathExists(binaryPath));
    if (!signingBlocked) {
      throw error;
    }
    console.warn(
      "[managed-smoke] continuing after Tauri updater signing failure because the packaged app artifact was already produced"
    );
  }
}

async function waitFor(assertion, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await assertion();
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function logStep(label) {
  currentStepLabel = label;
  currentStepStartedAt = Date.now();
  console.log(`\n[managed-smoke] ${label}`);
}

function shouldAttemptCliShimInstall(env) {
  return !(process.platform === "darwin" && env.CI === "true");
}

const packagedBinary = resolvePackagedBinary();
await ensurePackagedArtifact(packagedBinary);
if (!(await pathExists(packagedBinary))) {
  throw new Error(`Packaged desktop artifact not found: ${packagedBinary}`);
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-desktop-smoke-"));
const testRoot = path.join(tmpRoot, "managed-test-root");
const fakeHome = path.join(tmpRoot, "fake-home");
const fakePaseoHome = path.join(fakeHome, ".paseo");
const cliScratchHome = path.join(tmpRoot, "cli-scratch-home");
const externalHome = path.join(tmpRoot, "external-daemon-home");
const externalPort = await getAvailablePort();
const externalEndpoint = `127.0.0.1:${externalPort}`;
const relayPort = await getAvailablePort();
const relayEndpoint = `127.0.0.1:${relayPort}`;
const managedRuntimeDir = path.join(testRoot, "runtime");
await fs.mkdir(testRoot, { recursive: true });
await fs.mkdir(fakePaseoHome, { recursive: true });
await fs.mkdir(cliScratchHome, { recursive: true });
await fs.mkdir(externalHome, { recursive: true });
await fs.writeFile(path.join(fakePaseoHome, "sentinel.txt"), "do not touch\n", "utf8");

const fakePaseoSnapshotBefore = await snapshotTree(fakePaseoHome);
const smokeStartedAt = Date.now();
const smokeDeadlineMs = 15 * 60 * 1000;
let currentStepLabel = "initializing";
let currentStepStartedAt = smokeStartedAt;
const heartbeat = setInterval(() => {
  const elapsedSeconds = Math.floor((Date.now() - smokeStartedAt) / 1000);
  const currentStepSeconds = Math.floor((Date.now() - currentStepStartedAt) / 1000);
  console.log(
    `[managed-smoke] heartbeat elapsed=${elapsedSeconds}s currentStep=${JSON.stringify(currentStepLabel)} stepElapsed=${currentStepSeconds}s`
  );
  if (Date.now() - smokeStartedAt > smokeDeadlineMs) {
    console.error(
      `[managed-smoke] FAIL exceeded ${smokeDeadlineMs / 1000}s overall deadline during ${JSON.stringify(currentStepLabel)}`
    );
    process.exit(1);
  }
}, 30_000);
const managedEnv = {
  ...process.env,
  HOME: fakeHome,
  PASEO_HOME: cliScratchHome,
  PASEO_DESKTOP_TEST_ROOT: testRoot,
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
  PASEO_RELAY_ENABLED: "true",
  PASEO_RELAY_ENDPOINT: relayEndpoint,
  PASEO_RELAY_PUBLIC_ENDPOINT: relayEndpoint,
  PASEO_APP_BASE_URL: "https://app.paseo.test",
  PASEO_PRIMARY_LAN_IP: "192.168.1.12",
  CI: "true",
};
let externalPid = null;
let startedTemporaryExternalDaemon = false;
let relayProcess = null;
let smokePassed = false;
const forbiddenManagedReferences = ["127.0.0.1:6767", fakePaseoHome, managedRuntimeDir];
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is required to launch wrangler during managed desktop smoke tests.");
}

try {
  logStep(`Starting isolated local relay on ${relayEndpoint}`);
  relayProcess = spawn(process.execPath, [
    npmExecPath,
    "exec",
    "--",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(relayPort),
    "--live-reload=false",
    "--show-interactive-dev-session=false",
  ], {
    cwd: relayRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  relayProcess.stdout?.on("data", (chunk) => {
    process.stdout.write(`[managed-smoke relay] ${chunk}`);
  });
  relayProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(`[managed-smoke relay] ${chunk}`);
  });
  await waitFor(async () => {
    await execFileAsync(process.execPath, ["-e", `require("node:net").connect(${relayPort}, "127.0.0.1").on("connect", function () { this.end(); process.exit(0); }).on("error", () => process.exit(1));`]);
  }, 60_000, "relay HTTP endpoint to start");
  await waitForRelayWebSocketReady(relayEndpoint, 60_000);

  logStep(`Starting isolated external daemon on ${externalEndpoint}`);
  startedTemporaryExternalDaemon = true;
  await runWorkspaceCli(
    ["start", "--home", externalHome, "--listen", externalEndpoint, "--no-relay"],
    managedEnv
  );
  const externalStatus = await waitFor(
    async () => {
      const status = await readDaemonStatus(externalHome, managedEnv);
      assert.equal(status.status, "running");
      assert.ok(typeof status.pid === "number" && status.pid > 0, "expected external daemon pid");
      await runWorkspaceCli(["ls", "--host", externalEndpoint, "--json"], managedEnv);
      return status;
    },
    15_000,
    "external daemon to start"
  );
  externalPid = externalStatus.pid;
  assert.ok(externalPid, "external daemon pid should be present");

  logStep("Bootstrapping managed runtime from packaged desktop binary");
  const runtimeStatus = await runBinary(packagedBinary, ["--managed-headless", "runtime-status"], managedEnv);
  assert.equal(runtimeStatus.json.runtimeId, currentRuntimeId);
  assert.equal(runtimeStatus.json.runtimeVersion, currentRuntimeVersion);
  assert.match(runtimeStatus.json.managedHome, new RegExp(`^${escapeForRegExp(testRoot)}`));
  assert.match(
    runtimeStatus.json.runtimeRoot,
    new RegExp(escapeForRegExp(currentRuntimeId)),
    "runtime status should point into the bundled runtime selected by current-runtime.json"
  );
  assert.equal(
    runtimeStatus.json.runtimeRoot.startsWith(testRoot),
    false,
    "runtime status should not resolve into managed app data"
  );
  assert.ok(runtimeStatus.json.transportType === "socket" || runtimeStatus.json.transportType === "pipe");
  assert.notEqual(runtimeStatus.json.transportPath, "127.0.0.1:6767");
  assertNoForbiddenPathsOrPorts(runtimeStatus.json, forbiddenManagedReferences);
  assert.equal(await pathExists(managedRuntimeDir), false, "managed app data should not gain a runtime tree");
  const stateAfterRuntimeStatus = JSON.parse(
    await fs.readFile(path.join(testRoot, "managed-state.json"), "utf8")
  );
  assert.equal(stateAfterRuntimeStatus.runtimeId, currentRuntimeId);
  assert.equal(stateAfterRuntimeStatus.runtimeRoot, runtimeStatus.json.runtimeRoot);

  const managedBootstrap = await runBinary(packagedBinary, ["--managed-headless", "bootstrap"], managedEnv);
  const managedStart = managedBootstrap.json ?? await waitFor(
    async () => {
      const status = await runBinary(
        packagedBinary,
        ["--managed-headless", "daemon-status"],
        managedEnv
      );
      assert.equal(status.json?.daemonRunning, true);
      assert.ok(status.json?.daemonPid, "managed daemon pid should exist");
      return status.json;
    },
    10_000,
    "managed daemon bootstrap status"
  );
  assert.equal(managedStart.daemonRunning, true);
  assert.ok(managedStart.daemonPid, "managed daemon pid should exist");
  assert.equal(managedStart.runtimeRoot, runtimeStatus.json.runtimeRoot);
  assert.ok(
    managedStart.transportType === "socket" || managedStart.transportType === "pipe",
    "managed daemon should default to private IPC transport"
  );
  assert.notEqual(managedStart.transportPath, "127.0.0.1:6767");
  assertNoForbiddenPathsOrPorts(managedStart, forbiddenManagedReferences);
  assert.equal(await pathExists(managedRuntimeDir), false, "starting the daemon should not install a runtime copy");

  const managedPid = managedStart.daemonPid;
  const stateFile = path.join(testRoot, "managed-state.json");
  assert.equal(await pathExists(stateFile), true, "managed state file should be written");

  logStep("Verifying the managed daemon stays alive after the packaged command exits");
  await sleep(1_500);
  const persistedManagedStatus = await runBinary(
    packagedBinary,
    ["--managed-headless", "daemon-status"],
    managedEnv
  );
  assert.equal(persistedManagedStatus.json.daemonPid, managedPid);
  assert.equal(persistedManagedStatus.json.daemonRunning, true);
  assert.equal(persistedManagedStatus.json.relayEnabled, true);
  assertNoForbiddenPathsOrPorts(persistedManagedStatus.json, forbiddenManagedReferences);

  const attemptCliShimInstall = shouldAttemptCliShimInstall(managedEnv);
  const cliInstall = attemptCliShimInstall
    ? await (async () => {
        logStep("Installing CLI shim and verifying the bundled CLI target");
        return await runBinary(
          packagedBinary,
          ["--managed-headless", "install-cli-shim"],
          managedEnv
        );
      })()
    : {
        json: {
          status: "skippedInCi",
          installed: false,
          path: null,
          message: "Skipping privileged macOS CLI shim install in CI; verifying bundled CLI directly.",
        },
      };
  const cliShimPath = cliInstall.json.path;
  const cliShimInstalled =
    Boolean(attemptCliShimInstall && cliShimPath) && cliInstall.json.installed === true && (await pathExists(cliShimPath));
  if (attemptCliShimInstall) {
    assert.ok(cliShimPath, "CLI shim path should be returned");
    if (!cliShimInstalled) {
      assert.ok(cliInstall.json.manualInstructions, "manual CLI install instructions should be returned");
      assert.match(
        cliInstall.json.manualInstructions.commands,
        new RegExp(escapeForRegExp(runtimeStatus.json.runtimeRoot)),
        "manual CLI install instructions should point at the bundled runtime"
      );
      assertNoForbiddenPathsOrPorts(cliInstall.json.manualInstructions, forbiddenManagedReferences);
    }
  } else {
    logStep("Skipping privileged CLI shim install in CI and verifying the bundled CLI target directly");
  }
  const cliVersion = cliShimInstalled
    ? await execFileWithTimeout(cliShimPath, ["--version"], {
        env: managedEnv,
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      }, "installed CLI shim version check")
    : await runBundledRuntimeCli(
        runtimeStatus.json.runtimeRoot,
        managedStart.managedHome,
        ["--version"],
        managedEnv
      );
  assert.match(cliVersion.stdout.trim(), /^0\./);
  const shimStatus = cliShimInstalled
    ? await execFileWithTimeout(cliShimPath, ["daemon", "status", "--json"], {
        env: managedEnv,
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      }, "installed CLI shim daemon status")
    : await runBundledRuntimeCli(
        runtimeStatus.json.runtimeRoot,
        managedStart.managedHome,
        ["daemon", "status", "--json"],
        managedEnv
      );
  const shimDaemonStatus = JSON.parse(shimStatus.stdout.trim());
  assert.equal(shimDaemonStatus.pid, managedPid);
  assertNoForbiddenPathsOrPorts(shimDaemonStatus, forbiddenManagedReferences);

  logStep("Verifying relay connectivity still works after the desktop command has exited");
  const relayPairing = cliShimInstalled
    ? await execFileWithTimeout(
        cliShimPath,
        ["daemon", "pair", "--home", managedStart.managedHome],
        {
          env: managedEnv,
          cwd: repoRoot,
          maxBuffer: 4 * 1024 * 1024,
        },
        "installed CLI shim relay pairing"
      )
    : await runBundledRuntimeCli(
        runtimeStatus.json.runtimeRoot,
        managedStart.managedHome,
        ["daemon", "pair", "--home", managedStart.managedHome],
        managedEnv
      );
  const relayOfferUrl = parseOfferUrlFromCommandOutput(relayPairing.stdout);
  const relayOffer = decodeOfferFromFragmentUrl(relayOfferUrl);
  assert.equal(relayOffer.relay?.endpoint, relayEndpoint);
  const relayPong = await connectViaRelay(relayEndpoint, relayOffer);
  assert.deepEqual(relayPong, { type: "pong" });

  logStep("Reopening packaged desktop command path without spawning duplicate daemons");
  const managedRestartless = await runBinary(
    packagedBinary,
    ["--managed-headless", "bootstrap"],
    managedEnv
  );
  assert.equal(managedRestartless.json.daemonPid, managedPid);

  logStep("Verifying managed and external daemons coexist");
  const externalStatusAfter = await readDaemonStatus(externalHome, managedEnv);
  const externalPidAfter = externalStatusAfter.pid ?? null;
  assert.equal(externalStatusAfter.status, "running");
  assert.equal(externalPidAfter, externalPid);
  await runWorkspaceCli(["ls", "--host", externalEndpoint, "--json"], managedEnv);
  const managedStatus = await runBinary(
    packagedBinary,
    ["--managed-headless", "daemon-status"],
    managedEnv
  );
  assert.ok(managedStatus.json.serverId, "managed daemon should expose a server id");
  assertNoForbiddenPathsOrPorts(managedStatus.json, forbiddenManagedReferences);

  logStep("Enabling managed TCP exposure on an explicit non-default port");
  const tcpEnabled = await runBinary(
    packagedBinary,
    [
      "--managed-headless",
      "update-tcp",
      "--enabled",
      "true",
      "--host",
      "127.0.0.1",
      "--port",
      "7771",
    ],
    managedEnv
  );
  assert.equal(tcpEnabled.json.tcpEnabled, true);
  assert.equal(tcpEnabled.json.transportType, "tcp");
  assert.equal(tcpEnabled.json.transportPath, "127.0.0.1:7771");
  assert.notEqual(tcpEnabled.json.transportPath, "127.0.0.1:6767");
  assertNoForbiddenPathsOrPorts(tcpEnabled.json, [fakePaseoHome]);

  logStep("Disabling managed TCP exposure and returning to private transport");
  const tcpDisabled = await runBinary(
    packagedBinary,
    [
      "--managed-headless",
      "update-tcp",
      "--enabled",
      "false",
      "--host",
      "127.0.0.1",
      "--port",
      "7771",
    ],
    managedEnv
  );
  assert.equal(tcpDisabled.json.tcpEnabled, false);
  assert.notEqual(tcpDisabled.json.transportType, "tcp");
  assertNoForbiddenPathsOrPorts(tcpDisabled.json, forbiddenManagedReferences);

  logStep("Capturing diagnostics and verifying the fake ~/.paseo stayed untouched");
  const fakePaseoSnapshotAfter = await snapshotTree(fakePaseoHome);
  assert.deepEqual(fakePaseoSnapshotAfter, fakePaseoSnapshotBefore);
  await fs.writeFile(
    path.join(testRoot, "managed-daemon-smoke-diagnostics.json"),
    JSON.stringify(
      {
        runtimeStatus: runtimeStatus.json,
        managedBootstrap: managedBootstrap.json,
        managedStart,
        stateAfterRuntimeStatus,
        persistedManagedStatus: persistedManagedStatus.json,
        managedRestartless: managedRestartless.json,
        cliInstall: cliInstall.json,
        shimDaemonStatus,
        relayEndpoint,
        relayOfferUrl,
        relayPong,
        externalEndpoint,
        externalPid,
        externalPidAfter,
        managedStatus: managedStatus.json,
        tcpEnabled: tcpEnabled.json,
        tcpDisabled: tcpDisabled.json,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`\n[managed-smoke] PASS (${testRoot})`);
  smokePassed = true;
} finally {
  clearInterval(heartbeat);
  try {
    await runBinary(packagedBinary, ["--managed-headless", "stop-daemon"], managedEnv);
  } catch {}
  try {
    if (shouldAttemptCliShimInstall(managedEnv)) {
      await runBinary(packagedBinary, ["--managed-headless", "uninstall-cli-shim"], managedEnv);
    }
  } catch {}
  try {
    if (startedTemporaryExternalDaemon) {
      await runWorkspaceCli(["daemon", "stop", "--home", externalHome, "--json"]);
    }
  } catch {}
  try {
    await terminateChildProcess(relayProcess, "local relay");
  } catch {}
  // Force-exit: on Windows, taskkill may leave orphaned handles that keep the
  // Node event loop alive even after all child processes are dead.
  process.exit(smokePassed ? 0 : 1);
}
