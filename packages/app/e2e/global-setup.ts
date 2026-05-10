import { spawn, type ChildProcess, execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { Buffer } from "node:buffer";
import dotenv from "dotenv";
import { forkPaseoHomeMetadata, resolvePaseoHomePath } from "./helpers/paseo-home-fork";

interface WaitForServerOptions {
  host?: string;
  timeoutMs?: number;
  label: string;
  childProcess?: ChildProcess | null;
  getRecentOutput?: () => string;
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function createLineBuffer(maxLines = 120): { add: (line: string) => void; dump: () => string } {
  const lines: string[] = [];
  return {
    add(line: string) {
      lines.push(line);
      if (lines.length > maxLines) {
        lines.shift();
      }
    },
    dump() {
      return lines.join("\n");
    },
  };
}

function formatRecentOutput(getRecentOutput?: () => string): string {
  if (!getRecentOutput) {
    return "";
  }
  const output = getRecentOutput().trim();
  if (!output) {
    return "";
  }
  return `\nRecent output:\n${output}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port: number, options: WaitForServerOptions): Promise<void> {
  const { host = "127.0.0.1", timeoutMs = 15000, label, childProcess, getRecentOutput } = options;
  const start = Date.now();
  let lastConnectionError: unknown = null;

  while (Date.now() - start < timeoutMs) {
    if (childProcess && childProcess.exitCode !== null) {
      const signal = childProcess.signalCode ? `, signal ${childProcess.signalCode}` : "";
      throw new Error(
        `${label} exited before listening on ${host}:${port} (exit code ${childProcess.exitCode}${signal}).${formatRecentOutput(getRecentOutput)}`,
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, host, () => {
          socket.end();
          resolve();
        });
        socket.setTimeout(1000, () => {
          socket.destroy();
          reject(new Error(`Connection timed out to ${host}:${port}`));
        });
        socket.on("error", reject);
      });
      return;
    } catch (error) {
      lastConnectionError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const reason =
    lastConnectionError instanceof Error
      ? ` Last connection error: ${lastConnectionError.message}`
      : "";
  throw new Error(
    `${label} did not start on ${host}:${port} within ${timeoutMs}ms.${reason}${formatRecentOutput(getRecentOutput)}`,
  );
}

function parseRelayStartupFailure(line: string): string | null {
  const clean = stripAnsi(line);
  if (/Address already in use/i.test(clean)) {
    return clean;
  }
  if (/failed: ::bind\(/i.test(clean)) {
    return clean;
  }
  if (/Fatal uncaught/i.test(clean)) {
    return clean;
  }
  return null;
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    let pendingResolve: (() => void) | null = resolve;
    const settle = () => {
      if (!pendingResolve) return;
      const fn = pendingResolve;
      pendingResolve = null;
      clearTimeout(timeout);
      fn();
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      settle();
    }, 5000);
    child.once("exit", settle);
  });
}

function summarizeOpenAiErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "empty response body";
  }
  if (trimmed.length <= 240) {
    return trimmed;
  }
  return `${trimmed.slice(0, 240)}…`;
}

async function isOpenAiApiKeyUsable(apiKey: string | undefined): Promise<boolean> {
  const key = apiKey?.trim();
  if (!key) {
    return false;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/models?limit=1", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });
    if (response.ok) {
      return true;
    }
    const body = await response.text();
    console.warn(
      `[e2e] OPENAI_API_KEY probe failed (${response.status}): ${summarizeOpenAiErrorBody(body)}`,
    );
    return false;
  } catch (error) {
    console.warn(
      `[e2e] OPENAI_API_KEY probe request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

let daemonProcess: ChildProcess | null = null;
let metroProcess: ChildProcess | null = null;
let paseoHome: string | null = null;
let fakeGhBinDir: string | null = null;
let relayProcess: ChildProcess | null = null;

function resolveOptionalPaseoHomeEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "current") {
    return resolvePaseoHomePath("~/.paseo");
  }
  return resolvePaseoHomePath(trimmed);
}

interface OfferPayload {
  v: 2;
  serverId: string;
  daemonPublicKeyB64: string;
  relay: { endpoint: string };
}

async function createFakeGhBin(): Promise<string> {
  const binDir = await mkdtemp(path.join(tmpdir(), "paseo-e2e-gh-bin-"));
  const ghPath = path.join(binDir, "gh");
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);

function findRealGh() {
  const fakeBinDir = __dirname;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir === fakeBinDir) continue;
    const candidate = path.join(dir, "gh");
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function forwardToRealGh() {
  const realGh = findRealGh();
  if (!realGh) { console.error("[fake-gh] real gh not found in PATH"); process.exit(1); }
  const result = spawnSync(realGh, process.argv.slice(2), { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}

if (args[0] === "auth" && args[1] === "status") {
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  console.log(JSON.stringify([
    {
      number: 515,
      title: "Review selected start ref",
      url: "https://github.com/getpaseo/paseo/pull/515",
      state: "OPEN",
      body: "Fixture pull request for app e2e.",
      labels: [],
      baseRefName: "main",
      headRefName: "feature/start-from-pr"
    }
  ]));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view" && args[2] === "--json" && args[3]) {
  const fixture = path.join(process.cwd(), ".paseo-e2e-pr.json");
  if (fs.existsSync(fixture)) {
    console.log(fs.readFileSync(fixture, "utf8"));
    process.exit(0);
  }
  forwardToRealGh();
}

if (args[0] === "api" && args[1] === "graphql") {
  const fixture = path.join(process.cwd(), ".paseo-e2e-timeline.json");
  if (fs.existsSync(fixture)) {
    console.log(fs.readFileSync(fixture, "utf8"));
    process.exit(0);
  }
  forwardToRealGh();
}

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

forwardToRealGh();
`,
  );
  await chmod(ghPath, 0o755);
  return binDir;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

function ensureRelayBuildArtifact(repoRoot: string): void {
  const relayDistEntry = path.join(repoRoot, "packages/relay/dist/e2ee.js");
  if (existsSync(relayDistEntry)) {
    return;
  }

  console.log("[e2e] Building @getpaseo/relay for daemon startup");
  execSync("npm run build --workspace=@getpaseo/relay", {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function decodeOfferFromFragmentUrl(url: string): OfferPayload {
  const marker = "#offer=";
  const idx = url.indexOf(marker);
  if (idx === -1) {
    throw new Error(`missing ${marker} fragment: ${url}`);
  }
  const encoded = url.slice(idx + marker.length);
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  const offer = JSON.parse(json) as Partial<OfferPayload>;
  if (offer.v !== 2) throw new Error("offer.v missing/invalid");
  if (!offer.serverId) throw new Error("offer.serverId missing");
  if (!offer.daemonPublicKeyB64) throw new Error("offer.daemonPublicKeyB64 missing");
  if (!offer.relay?.endpoint) throw new Error("offer.relay.endpoint missing");
  return offer as OfferPayload;
}

function loadPairingOfferFromCli(repoRoot: string, paseoHomePath: string): OfferPayload {
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", "packages/cli/src/index.ts", "daemon", "pair", "--json"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PASEO_HOME: paseoHomePath,
      },
      encoding: "utf8",
    },
  );
  const payload = JSON.parse(stdout) as { relayEnabled?: boolean; url?: string | null };
  if (payload.relayEnabled !== true || typeof payload.url !== "string") {
    throw new Error(`Unexpected daemon pair response: ${stdout}`);
  }
  return decodeOfferFromFragmentUrl(payload.url);
}

async function waitForPairingOfferFromCli(args: {
  repoRoot: string;
  paseoHome: string;
  timeoutMs?: number;
}): Promise<OfferPayload> {
  const timeoutMs = args.timeoutMs ?? 15000;
  const start = Date.now();
  let lastError: unknown = null;

  while (Date.now() - start < timeoutMs) {
    try {
      return loadPairingOfferFromCli(args.repoRoot, args.paseoHome);
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }

  throw new Error(
    `Timed out waiting for \`paseo daemon pair --json\` to produce a pairing offer: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

interface DictationConfig {
  openAiUsable: boolean;
  localModelsDir: string | null;
}

async function loadEnvTestFile(repoRoot: string): Promise<void> {
  const envTestPath = path.join(repoRoot, ".env.test");
  if (existsSync(envTestPath)) {
    dotenv.config({ path: envTestPath });
  }
}

async function applyPaseoHomeFork(targetHome: string): Promise<void> {
  const forkSourceHome = resolveOptionalPaseoHomeEnv(process.env.E2E_FORK_PASEO_HOME_FROM);
  if (!forkSourceHome) {
    return;
  }
  const forkResult = await forkPaseoHomeMetadata({
    sourceHome: forkSourceHome,
    targetHome,
  });
  process.env.E2E_FORK_SOURCE_PASEO_HOME = forkResult.sourceHome;
  process.env.E2E_FORK_TARGET_PASEO_HOME = forkResult.targetHome;
  process.env.E2E_FORK_COPIED_FILES = String(forkResult.copiedFiles);
  process.env.E2E_FORK_COPIED_BYTES = String(forkResult.copiedBytes);
  console.log(
    `[e2e] Forked Paseo metadata from ${forkResult.sourceHome} to ${forkResult.targetHome} ` +
      `(${forkResult.agentFiles} agent files, ${forkResult.projectFiles} project registry files, ` +
      `${forkResult.copiedBytes} bytes)`,
  );
  if (forkResult.skippedMissing.length > 0) {
    console.warn(
      `[e2e] Paseo metadata fork skipped missing paths: ${forkResult.skippedMissing.join(", ")}`,
    );
  }
}

async function resolveDictationConfig(): Promise<DictationConfig> {
  const openAiUsable = await isOpenAiApiKeyUsable(process.env.OPENAI_API_KEY);
  const defaultLocalModelsDir = path.join(
    process.env.HOME ?? "",
    ".paseo",
    "models",
    "local-speech",
  );
  const hasDefaultLocalModelsDir =
    defaultLocalModelsDir.trim().length > 0 && existsSync(defaultLocalModelsDir);

  // Fork PRs run without secrets and usually without local models. Don't crash
  // the whole Playwright run — disable dictation/voice and let tests that need
  // them gate on PASEO_DICTATION_ENABLED.
  if (!openAiUsable && !hasDefaultLocalModelsDir) {
    console.warn(
      "[e2e] Neither OPENAI_API_KEY nor local speech models found — running with dictation/voice disabled. " +
        "Tests that require dictation should gate on PASEO_DICTATION_ENABLED.",
    );
    return { openAiUsable: false, localModelsDir: null };
  }

  const dictationProvider = openAiUsable ? "openai" : "local";
  const localModelsDir = dictationProvider === "local" ? defaultLocalModelsDir : null;
  console.log(
    `[e2e] Dictation STT provider: ${dictationProvider}${openAiUsable ? "" : " (OpenAI probe failed)"}`,
  );
  return { openAiUsable, localModelsDir };
}

interface RelayStreamState {
  failureLine: string | null;
  readyForSelectedPort: boolean;
}

function attachRelayStreamHandlers(
  child: ChildProcess,
  relayPort: number,
  buffer: ReturnType<typeof createLineBuffer>,
  state: RelayStreamState,
): void {
  function handleChunk(data: Buffer, streamTag: "stdout" | "stderr") {
    const lines = data
      .toString()
      .split("\n")
      .filter((line) => line.trim());
    for (const line of lines) {
      buffer.add(`[${streamTag}] ${line}`);
      const failure = parseRelayStartupFailure(line);
      if (failure) {
        state.failureLine = failure;
      }
      const clean = stripAnsi(line);
      const readyMatch = clean.match(/Ready on .*:(\d+)\b/i);
      if (readyMatch && Number(readyMatch[1]) === relayPort) {
        state.readyForSelectedPort = true;
      }
      if (streamTag === "stdout") {
        console.log(`[relay] ${line}`);
      } else {
        console.error(`[relay] ${line}`);
      }
    }
  }

  child.stdout?.on("data", (data: Buffer) => handleChunk(data, "stdout"));
  child.stderr?.on("data", (data: Buffer) => handleChunk(data, "stderr"));
}

async function awaitRelayReady(
  child: ChildProcess,
  relayPort: number,
  state: RelayStreamState,
  buffer: ReturnType<typeof createLineBuffer>,
): Promise<void> {
  await waitForServer(relayPort, {
    label: "Relay dev server",
    timeoutMs: 30000,
    childProcess: child,
    getRecentOutput: buffer.dump,
  });

  const readyDeadline = Date.now() + 5000;
  function isRelayReadyCheckPending(): boolean {
    if (state.readyForSelectedPort) return false;
    if (state.failureLine !== null) return false;
    if (child.exitCode !== null) return false;
    if (child.signalCode !== null) return false;
    if (Date.now() >= readyDeadline) return false;
    return true;
  }
  while (isRelayReadyCheckPending()) await sleep(100);

  if (state.failureLine) {
    throw new Error(`Relay startup failed: ${state.failureLine}`);
  }
  if (!state.readyForSelectedPort) {
    throw new Error(
      `Relay process did not report ready for selected port ${relayPort}.${formatRecentOutput(
        buffer.dump,
      )}`,
    );
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Relay process exited before startup completed (exit code ${child.exitCode}, signal ${child.signalCode}).${formatRecentOutput(
        buffer.dump,
      )}`,
    );
  }
}

async function startRelay(): Promise<number> {
  const relayDir = path.resolve(__dirname, "..", "..", "relay");
  const maxRelayStartupAttempts = 5;
  let lastRelayStartupError: unknown = null;

  for (let attempt = 1; attempt <= maxRelayStartupAttempts; attempt += 1) {
    const relayPort = await getAvailablePort();
    const buffer = createLineBuffer();
    const state: RelayStreamState = { failureLine: null, readyForSelectedPort: false };

    relayProcess = spawn(
      "npx",
      ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(relayPort)],
      {
        cwd: relayDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );
    attachRelayStreamHandlers(relayProcess, relayPort, buffer, state);

    try {
      await awaitRelayReady(relayProcess, relayPort, state, buffer);
      return relayPort;
    } catch (error) {
      lastRelayStartupError = error;
      await stopProcess(relayProcess);
      relayProcess = null;
    }
  }

  const message =
    lastRelayStartupError instanceof Error
      ? lastRelayStartupError.message
      : String(lastRelayStartupError);
  throw new Error(
    `Failed to start relay dev server after ${maxRelayStartupAttempts} attempts. ${message}`,
  );
}

function startMetro(metroPort: number, buffer: ReturnType<typeof createLineBuffer>): ChildProcess {
  const appDir = path.resolve(__dirname, "..");
  const child = spawn("npx", ["expo", "start", "--web", "--port", String(metroPort)], {
    cwd: appDir,
    env: {
      ...process.env,
      BROWSER: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    const lines = data
      .toString()
      .split("\n")
      .filter((line) => line.trim());
    for (const line of lines) {
      buffer.add(`[stdout] ${line}`);
      console.log(`[metro] ${line}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data
      .toString()
      .split("\n")
      .filter((line) => line.trim());
    for (const line of lines) {
      buffer.add(`[stderr] ${line}`);
      console.error(`[metro] ${line}`);
    }
  });

  return child;
}

interface DaemonSpawnArgs {
  port: number;
  relayPort: number;
  metroPort: number;
  paseoHome: string;
  fakeGhBinDir: string;
  dictation: DictationConfig;
  buffer: ReturnType<typeof createLineBuffer>;
}

function startDaemon(args: DaemonSpawnArgs): ChildProcess {
  const serverDir = path.resolve(__dirname, "../../..", "packages/server");
  const tsxBin = execSync("which tsx").toString().trim();
  const { openAiUsable, localModelsDir } = args.dictation;

  const child = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PATH: `${args.fakeGhBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PASEO_HOME: args.paseoHome,
      PASEO_SERVER_ID: "srv_e2e_test_daemon",
      PASEO_LISTEN: `0.0.0.0:${args.port}`,
      PASEO_RELAY_ENDPOINT: `127.0.0.1:${args.relayPort}`,
      PASEO_CORS_ORIGINS: `http://localhost:${args.metroPort}`,
      PASEO_DICTATION_ENABLED: openAiUsable ? "1" : "0",
      PASEO_VOICE_MODE_ENABLED: openAiUsable ? "1" : "0",
      PASEO_NODE_ENV: "development",
      ...(openAiUsable
        ? {
            PASEO_DICTATION_STT_PROVIDER: "openai",
            PASEO_VOICE_STT_PROVIDER: "openai",
            PASEO_VOICE_TTS_PROVIDER: "openai",
          }
        : {}),
      ...(localModelsDir ? { PASEO_LOCAL_MODELS_DIR: localModelsDir } : {}),
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let stdoutBuffer = "";
  child.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      args.buffer.add(`[stdout] ${trimmed}`);
      console.log(`[daemon] ${trimmed}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data
      .toString()
      .split("\n")
      .filter((line) => line.trim());
    for (const line of lines) {
      args.buffer.add(`[stderr] ${line}`);
      console.error(`[daemon] ${line}`);
    }
  });

  return child;
}

async function performCleanup(shouldRemovePaseoHome: boolean): Promise<void> {
  await Promise.all([
    stopProcess(daemonProcess),
    stopProcess(metroProcess),
    stopProcess(relayProcess),
  ]);
  daemonProcess = null;
  metroProcess = null;
  relayProcess = null;
  if (paseoHome && shouldRemovePaseoHome) {
    await rm(paseoHome, { recursive: true, force: true });
    paseoHome = null;
  } else if (paseoHome) {
    console.log(`[e2e] Preserving PASEO_HOME: ${paseoHome}`);
  }
  if (fakeGhBinDir) {
    await rm(fakeGhBinDir, { recursive: true, force: true });
    fakeGhBinDir = null;
  }
}

export default async function globalSetup() {
  const repoRoot = path.resolve(__dirname, "../../..");
  ensureRelayBuildArtifact(repoRoot);
  await loadEnvTestFile(repoRoot);

  const port = await getAvailablePort();
  const metroPort = await getAvailablePort();
  const requestedPaseoHome = resolveOptionalPaseoHomeEnv(process.env.E2E_PASEO_HOME);
  const shouldRemovePaseoHome = !requestedPaseoHome && process.env.E2E_KEEP_PASEO_HOME !== "1";
  paseoHome = requestedPaseoHome ?? (await mkdtemp(path.join(tmpdir(), "paseo-e2e-home-")));
  fakeGhBinDir = await createFakeGhBin();
  const metroLineBuffer = createLineBuffer();
  const daemonLineBuffer = createLineBuffer();

  await applyPaseoHomeFork(paseoHome);

  const cleanup = () => performCleanup(shouldRemovePaseoHome);

  const dictation = await resolveDictationConfig();

  try {
    const relayPort = await startRelay();
    metroProcess = startMetro(metroPort, metroLineBuffer);
    daemonProcess = startDaemon({
      port,
      relayPort,
      metroPort,
      paseoHome,
      fakeGhBinDir,
      dictation,
      buffer: daemonLineBuffer,
    });

    await Promise.all([
      waitForServer(port, {
        label: "Paseo daemon",
        childProcess: daemonProcess,
        getRecentOutput: daemonLineBuffer.dump,
      }),
      waitForServer(metroPort, {
        label: "Metro web server",
        timeoutMs: 120000,
        childProcess: metroProcess,
        getRecentOutput: metroLineBuffer.dump,
      }),
    ]);

    const offer = await waitForPairingOfferFromCli({
      repoRoot,
      paseoHome,
    });

    process.env.E2E_DAEMON_PORT = String(port);
    process.env.E2E_RELAY_PORT = String(relayPort);
    process.env.E2E_SERVER_ID = offer.serverId;
    process.env.E2E_RELAY_DAEMON_PUBLIC_KEY = offer.daemonPublicKeyB64;
    process.env.E2E_METRO_PORT = String(metroPort);
    process.env.E2E_PASEO_HOME = paseoHome;
    console.log(
      `[e2e] Test daemon started on port ${port}, Metro on port ${metroPort}, home: ${paseoHome}`,
    );

    return async () => {
      await cleanup();
      console.log("[e2e] Test daemon stopped");
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
