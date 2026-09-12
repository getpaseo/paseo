import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
const desktopDir = path.join(rootDir, "packages", "desktop");
const readyTimeoutMs = 180_000;

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to reserve an Electron test port"));
        }
        resolve(address.port);
      });
    });
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function seedPaseoHome({ paseoHome, listen, workspaceId, cwd }) {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const projectId = `project-${workspaceId}`;
  fs.mkdirSync(cwd, { recursive: true });
  writeJson(path.join(paseoHome, "config.json"), {
    version: 1,
    daemon: {
      listen,
      relay: { enabled: false },
      mcp: { enabled: true, injectIntoAgents: false },
      cors: { allowedOrigins: ["*"] },
    },
  });
  writeJson(path.join(paseoHome, "projects", "projects.json"), [
    {
      projectId,
      rootPath: cwd,
      kind: "non_git",
      displayName: "Electron keyboard project",
      customName: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(paseoHome, "projects", "workspaces.json"), [
    {
      workspaceId,
      projectId,
      cwd,
      kind: "directory",
      displayName: "Electron keyboard workspace",
      title: "Electron keyboard workspace",
      branch: null,
      baseBranch: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      pinnedAt: null,
    },
  ]);
}

function spawnLogged({ name, command, args, env, artifactDir }) {
  const logPath = path.join(artifactDir, `${name}.log`);
  const descriptor = fs.openSync(logPath, "a");
  let child;
  try {
    child = spawn(command, args, {
      cwd: rootDir,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", descriptor, descriptor],
    });
  } finally {
    fs.closeSync(descriptor);
  }
  const processInfo = { child, logPath, error: null };
  child.once("error", (error) => {
    processInfo.error = error;
  });
  return processInfo;
}

async function waitForPort(port, processInfo) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (processInfo.error) throw processInfo.error;
    const exited = processInfo.child.exitCode !== null || processInfo.child.signalCode !== null;
    if (exited) {
      throw new Error(`Process exited before opening port ${port}; see ${processInfo.logPath}`);
    }
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for port ${port}; see ${processInfo.logPath}`);
}

async function stopProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const target = process.platform === "win32" ? child.pid : -child.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(target, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForAppPage(browser, expoPort) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().includes(`localhost:${expoPort}`));
    if (page) return page;
    await delay(250);
  }
  throw new Error("Timed out waiting for the real Electron app renderer");
}

export async function startElectronSession({ artifactDir }) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-electron-e2e-"));
  const paseoHome = path.join(runtimeDir, "paseo-home");
  const cwd = path.join(runtimeDir, "workspace");
  const workspaceId = "electron-keyboard-workspace";
  const children = [];
  let browser = null;
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    await browser?.close().catch(() => undefined);
    const stopped = await Promise.allSettled(children.toReversed().map(stopProcess));
    fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    for (const result of stopped) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  try {
    const [daemonPort, expoPort, cdpPort] = await Promise.all([
      reservePort(),
      reservePort(),
      reservePort(),
    ]);
    const listen = `127.0.0.1:${daemonPort}`;
    seedPaseoHome({ paseoHome, listen, workspaceId, cwd });
    const commonEnv = {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: listen,
      PASEO_DAEMON_ENDPOINT: `localhost:${daemonPort}`,
      PASEO_CORS_ORIGINS: "*",
      PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      PASEO_DICTATION_ENABLED: "0",
      PASEO_VOICE_MODE_ENABLED: "0",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    const daemon = spawnLogged({
      name: "daemon",
      command: process.execPath,
      args: ["--import", "tsx", path.join(rootDir, "packages/server/scripts/dev-runner.ts")],
      env: { ...commonEnv, PASEO_NODE_ENV: "development" },
      artifactDir,
    });
    children.push(daemon.child);
    await waitForPort(daemonPort, daemon);

    const desktopArgs = [process.execPath, path.join(desktopDir, "scripts/dev-runner.mjs")];
    const isLinux = process.platform === "linux";
    const command = isLinux ? "xvfb-run" : desktopArgs.shift();
    const args = isLinux
      ? ["-a", "--server-args=-screen 0 1280x800x24", ...desktopArgs, "--no-sandbox"]
      : desktopArgs;
    const desktop = spawnLogged({
      name: "desktop",
      command,
      args,
      env: {
        ...commonEnv,
        EXPO_PORT: String(expoPort),
        EXPO_DEV_URL: `http://localhost:${expoPort}`,
        PASEO_ELECTRON_REMOTE_DEBUGGING_PORT: String(cdpPort),
        PASEO_ELECTRON_USER_DATA_DIR: path.join(runtimeDir, "electron-user-data"),
        PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
      },
      artifactDir,
    });
    children.push(desktop.child);
    await waitForPort(cdpPort, desktop);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitForAppPage(browser, expoPort);
    page.setDefaultTimeout(30_000);
    const statusHandle = await page.waitForFunction(
      async () => {
        if (typeof window.paseoDesktop?.invoke !== "function") return null;
        const status = await window.paseoDesktop.invoke("desktop_daemon_status");
        return typeof status?.serverId === "string" ? status : null;
      },
      undefined,
      { timeout: readyTimeoutMs },
    );
    const status = await statusHandle.jsonValue();
    await statusHandle.dispose();
    const serverId = status.serverId;
    await page
      .getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`)
      .waitFor({ state: "visible", timeout: readyTimeoutMs });
    return { page, browser, paseoHome, daemonPort, serverId, workspaceId, cwd, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runElectronScenario({ artifactDir, report, recordVideo }, scenario) {
  let session;
  let tracing;
  const cleanups = [];

  async function recordFailure(failure) {
    const details = failure?.stack ?? String(failure);
    const alreadyFailed = report.result === "failed";
    if (alreadyFailed) {
      report.secondaryErrors ??= [];
      report.secondaryErrors.push(details);
    } else {
      report.error = details;
    }
    report.result = "failed";
    process.exitCode = 1;
    console.error(failure);
    if (!alreadyFailed) {
      await session?.page
        .screenshot({ path: path.join(artifactDir, "failure.png") })
        .catch(() => undefined);
    }
  }

  try {
    session = await startElectronSession({ artifactDir });
    const contextTracing = session.browser.contexts()[0].tracing;
    await contextTracing.start({ screenshots: !recordVideo, snapshots: true, sources: true });
    tracing = contextTracing;
    await scenario({ ...session, addCleanup: (cleanup) => cleanups.push(cleanup) });
    report.result = "passed";
  } catch (error) {
    await recordFailure(error);
  } finally {
    for (const cleanup of cleanups.toReversed()) {
      await Promise.resolve().then(cleanup).catch(recordFailure);
    }
    await tracing?.stop({ path: path.join(artifactDir, "trace.zip") }).catch(recordFailure);
    await session?.close().catch(recordFailure);
    writeJson(path.join(artifactDir, "result.json"), report);
    console.log(`Evidence: ${artifactDir}`);
  }
  return report;
}
