#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPaseoClient } from "../../client/dist/index.js";
import { chromium } from "playwright";
import { WebSocket } from "ws";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const devRunner = path.join(desktopDir, "scripts", "dev-runner.mjs");
const timeoutMs = 90_000;
const serverId = "workflow-electron-visual";
const workspaceId = "workflow-electron-workspace";
const projectId = "workflow-electron-project";
const workflowName = "electron-visual-demo";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
          return reject(new Error("Failed to reserve a local port"));
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForPort(port, label, processInfo) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      processInfo &&
      (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null)
    ) {
      throw new Error(`${label} exited before opening its port; see ${processInfo.logPath}`);
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
  throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function seedPaseoHome(paseoHome, listen, workspaceRoot) {
  const timestamp = "2026-01-01T00:00:00.000Z";
  fs.mkdirSync(workspaceRoot, { recursive: true });
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
      rootPath: workspaceRoot,
      kind: "non_git",
      displayName: "Workflow Electron project",
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
      cwd: workspaceRoot,
      kind: "directory",
      displayName: "Workflow Electron workspace",
      title: "Workflow Electron workspace",
      branch: null,
      baseBranch: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      pinnedAt: null,
    },
  ]);
}

function spawnLogged(name, command, args, options, logDir) {
  const logPath = path.join(logDir, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  return { child, logPath };
}

function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // The isolated process may exit between the liveness check and signal.
  }
}

async function waitForAppPage(browser, expoPort) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes(`localhost:${expoPort}`)) return page;
      }
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the real Electron app renderer");
}

async function waitForDesktopStatus(page) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(async () => {
        if (typeof window.paseoDesktop?.invoke !== "function") return null;
        return await window.paseoDesktop.invoke("desktop_daemon_status");
      });
      if (status?.serverId === serverId) return status;
    } catch {
      // Metro replaces the renderer execution context during its first load.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the Electron desktop bridge and isolated daemon");
}

function visualWorkflowSpec(worktree) {
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name: workflowName,
    description: "Sanitized native workflow used for real Electron visual verification.",
    parameters: {
      workspaceRef: {
        type: "string",
        required: true,
        defaultFrom: "current.workspace",
        description: "Existing Paseo workspace.",
      },
      worktreeRef: {
        type: "path",
        required: true,
        defaultFrom: "current.worktree",
        description: "Existing workspace directory.",
      },
    },
    bindings: {
      workspace: "{{ parameters.workspaceRef }}",
      worktree: "{{ parameters.worktreeRef }}",
    },
    workspace: {
      createWorktree: {
        cwd: "{{ parameters.worktreeRef }}",
        target: { mode: "branch-off" },
      },
    },
    agents: {
      worker: {
        persistence: "reuse-agent",
        createAgent: {
          title: "Electron workflow visual worker",
          provider: "mock",
          model: "ten-second-stream",
          settings: { modeId: "load-test" },
        },
      },
    },
    protocol: { maxAttempts: 2 },
    entry: "main",
    flows: {
      main: {
        initial: "work",
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "work",
              emits: { done: { description: "Complete the visual fixture." } },
            },
            on: {
              done: "finish",
              "error.agent": "failed",
              "error.protocol": "failed",
            },
          },
          finish: { return: { output: "{{ event.message }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    },
    limits: { maxIterations: 2, maxRuntime: "5m" },
    inputs: { fixture: "electron" },
    prompts: {
      work: [
        "Complete the sanitized Electron workflow visual fixture.",
        `The bound worktree is ${worktree}.`,
        'PASEO_WORKFLOW_TEST_SCRIPT: {"delayMs":250,"rules":{"done":[{"event":"done","message":"Electron native workflow completed."}]}}',
      ].join("\n"),
    },
  };
}

async function seedCompletedRun(daemonPort, workspaceRoot) {
  const client = createPaseoClient({
    url: `ws://127.0.0.1:${daemonPort}/ws`,
    clientId: "workflow-electron-visual-seed",
    appVersion: "0.2.5",
    webSocketFactory: (url, options) => new WebSocket(url, { headers: options?.headers }),
  });
  await client.connect();
  try {
    const saved = await client.workflows.saveSpec(visualWorkflowSpec(workspaceRoot));
    assert(saved.summary && !saved.error, saved.error ?? "Workflow save returned no summary");
    const started = await client.workflows.start({
      workflowId: workflowName,
      context: { workspaceId },
    });
    assert(started.run && !started.error, started.error ?? "Workflow start returned no run");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const inspected = await client.workflows.inspect(started.run.id);
      if (inspected.error) throw new Error(inspected.error);
      if (inspected.details?.run.status === "complete") return inspected.details;
      if (inspected.details && ["failed", "stopped"].includes(inspected.details.run.status)) {
        throw new Error(
          `Workflow reached ${inspected.details.run.status}: ${inspected.details.run.reason}`,
        );
      }
      await delay(100);
    }
    throw new Error(`Workflow ${started.run.id} did not complete`);
  } finally {
    await client.close();
  }
}

async function main() {
  const artifactDir =
    process.env.PASEO_WORKFLOW_QA_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "paseo-workflow-electron-artifacts-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-workflow-electron-"));
  fs.mkdirSync(artifactDir, { recursive: true });
  const paseoHome = path.join(runtimeDir, "paseo-home");
  const userData = path.join(runtimeDir, "electron-user-data");
  const workspaceRoot = path.join(runtimeDir, "workspace");
  fs.mkdirSync(paseoHome, { recursive: true });

  const [daemonPort, expoPort, cdpPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  assert(daemonPort !== 6767, "The Electron workflow test must not use port 6767");
  const listen = `127.0.0.1:${daemonPort}`;
  seedPaseoHome(paseoHome, listen, workspaceRoot);
  const children = [];
  let browser = null;

  try {
    const commonEnv = {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_SERVER_ID: serverId,
      PASEO_LISTEN: listen,
      PASEO_DAEMON_ENDPOINT: `localhost:${daemonPort}`,
      PASEO_CORS_ORIGINS: "*",
      PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      PASEO_DICTATION_ENABLED: "0",
      PASEO_VOICE_MODE_ENABLED: "0",
      PASEO_RELAY_ENABLED: "0",
      PASEO_NODE_ENV: "development",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    const daemon = spawnLogged(
      "workflow-electron-daemon",
      process.execPath,
      ["--import", "tsx", path.join(rootDir, "packages/server/scripts/dev-runner.ts")],
      { cwd: rootDir, env: commonEnv },
      artifactDir,
    );
    children.push(daemon.child);
    await waitForPort(daemonPort, "isolated daemon", daemon);
    const completed = await seedCompletedRun(daemonPort, workspaceRoot);

    const desktopArgs = [
      process.execPath,
      devRunner,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ];
    const desktopCommand = process.platform === "linux" ? "xvfb-run" : desktopArgs.shift();
    const desktopCommandArgs =
      process.platform === "linux"
        ? ["-a", "--server-args=-screen 0 1280x800x24", ...desktopArgs]
        : desktopArgs;
    const desktop = spawnLogged(
      "workflow-electron-desktop",
      desktopCommand,
      desktopCommandArgs,
      {
        cwd: rootDir,
        env: {
          ...commonEnv,
          EXPO_PORT: String(expoPort),
          EXPO_DEV_URL: `http://localhost:${expoPort}`,
          PASEO_ELECTRON_REMOTE_DEBUGGING_PORT: String(cdpPort),
          PASEO_ELECTRON_USER_DATA_DIR: userData,
          PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
        },
      },
      artifactDir,
    );
    children.push(desktop.child);
    await waitForPort(cdpPort, "Electron CDP", desktop);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitForAppPage(browser, expoPort);
    await waitForDesktopStatus(page);
    assert(
      await page.evaluate(() => typeof window.paseoDesktop?.invoke === "function"),
      "The visual test is not running in Electron",
    );

    const workspaceRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
    await workspaceRow.waitFor({ state: "visible", timeout: timeoutMs });
    await workspaceRow.click();
    await page.getByTestId("sidebar-workflows").click();
    const runCard = page.getByTestId(`workflow-run-${completed.run.id}`);
    await runCard.waitFor({ state: "visible", timeout: timeoutMs });
    await runCard.click();
    const details = page.getByTestId("workflow-run-details");
    await details.waitFor({ state: "visible", timeout: timeoutMs });
    assert(
      (await details.textContent())?.includes("Rendered prompts"),
      "Rendered prompts are hidden",
    );
    assert((await details.textContent())?.includes("Persisted state"), "Persisted state is hidden");

    const screenshotPath = path.join(artifactDir, "workflows-electron.png");
    await page.screenshot({ path: screenshotPath });
    writeJson(path.join(artifactDir, "workflows-electron-result.json"), {
      platform: process.platform,
      electronBridge: true,
      runId: completed.run.id,
      status: completed.run.status,
      iteration: completed.run.iteration,
      eventCount: completed.events.length,
      promptCount: completed.prompts.length,
      screenshot: screenshotPath,
    });
    console.log(`Electron workflow visual QA passed. Evidence: ${screenshotPath}`);
  } catch (error) {
    console.error(`Electron workflow visual QA failed. Artifacts: ${artifactDir}`);
    console.error(error);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.toReversed()) stopProcess(child);
    await delay(1_000);
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`Failed to remove isolated Electron QA state ${runtimeDir}`, error);
    }
  }
}

await main();
