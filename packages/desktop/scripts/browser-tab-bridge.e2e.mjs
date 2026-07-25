#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const devRunner = path.join(desktopDir, "scripts", "dev-runner.mjs");
const workspaceIds = [
  "tab-bridge-original",
  "tab-bridge-evict-one",
  "tab-bridge-evict-two",
  "tab-bridge-evict-three",
];
const timeoutMs = 90_000;

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
      throw new Error(
        `${label} process exited before opening its port; see ${processInfo.logPath}`,
      );
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
  const projects = workspaceIds.map((workspaceId, index) => {
    const cwd = path.join(workspaceRoot, `workspace-${index + 1}`);
    fs.mkdirSync(cwd, { recursive: true });
    return {
      projectId: `project-${workspaceId}`,
      rootPath: cwd,
      kind: "non_git",
      displayName: `Tab bridge project ${index + 1}`,
      customName: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
  });
  const workspaces = workspaceIds.map((workspaceId, index) => ({
    workspaceId,
    projectId: projects[index].projectId,
    cwd: projects[index].rootPath,
    kind: "directory",
    displayName: `Tab bridge workspace ${index + 1}`,
    title: `Tab bridge workspace ${index + 1}`,
    branch: null,
    baseBranch: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    pinnedAt: null,
  }));

  writeJson(path.join(paseoHome, "config.json"), {
    version: 1,
    daemon: {
      listen,
      relay: { enabled: false },
      mcp: { enabled: true, injectIntoAgents: false },
      browserTools: { enabled: true },
      cors: { allowedOrigins: ["*"] },
    },
  });
  writeJson(path.join(paseoHome, "projects", "projects.json"), projects);
  writeJson(path.join(paseoHome, "projects", "workspaces.json"), workspaces);
}

function spawnLogged(name, command, args, options, logDir) {
  const logPath = path.join(logDir, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let openStreams = 2;
  const closeLogStream = () => {
    openStreams -= 1;
    if (openStreams === 0) log.end();
  };
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.stdout.once("end", closeLogStream);
  child.stderr.once("end", closeLogStream);
  return { child, logPath };
}

function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process may exit between the liveness check and signal delivery.
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
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(async () => {
        if (typeof window.paseoDesktop?.invoke !== "function") return null;
        return await window.paseoDesktop.invoke("desktop_daemon_status");
      });
      if (typeof status?.serverId === "string") return status;
    } catch (error) {
      // Metro may replace the renderer execution context during its initial load.
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for the Electron desktop bridge${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

async function startTargetPage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Tab bridge target</title></head>
        <body>
          <button id="bridge-target" onclick="this.textContent = 'Clicked'">Bridge target</button>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Target page did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function mcpPayload(result, command) {
  const payload = result.structuredContent;
  assert(
    payload && typeof payload === "object",
    `${command} returned no structured payload: ${JSON.stringify(result)}`,
  );
  assert(payload.ok === true, `${command} failed: ${JSON.stringify(payload)}`);
  return payload.result;
}

async function callBrowserTool(client, name, args = {}) {
  return mcpPayload(await client.callTool({ name, args }), name);
}

async function createCallerAgent(daemonPort) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${daemonPort}/mcp/agents`),
  );
  const client = await experimental_createMCPClient({ transport });
  try {
    const response = await client.callTool({
      name: "create_agent",
      args: {
        relationship: { kind: "detached" },
        workspace: { kind: "existing", workspaceId: workspaceIds[0] },
        title: "Browser tab bridge E2E caller",
        provider: "mock/ten-second-stream",
        settings: { modeId: "load-test" },
        initialPrompt: "Remain available while the browser bridge regression runs.",
        background: true,
      },
    });
    const result = response.structuredContent;
    assert(
      result && typeof result === "object",
      `create_agent returned no structured payload: ${JSON.stringify(response)}`,
    );
    assert(typeof result.agentId === "string", "create_agent returned no caller agent id");
    assert(
      result.workspaceId === workspaceIds[0],
      `MCP caller attached to unexpected workspace ${result.workspaceId}`,
    );
    return result.agentId;
  } finally {
    await client.close();
  }
}

async function readGuest(page, browserId) {
  return await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement) || typeof webview.getWebContentsId !== "function") {
      return null;
    }
    return {
      webContentsId: webview.getWebContentsId(),
      parentId: webview.parentElement?.id ?? null,
    };
  }, browserId);
}

async function runRegression({ page, client, serverId, targetUrl }) {
  const originalWorkspaceId = workspaceIds[0];
  const originalWorkspaceRow = page.getByTestId(
    `sidebar-workspace-row-${serverId}:${originalWorkspaceId}`,
  );
  await originalWorkspaceRow.waitFor({ state: "visible", timeout: timeoutMs });
  await originalWorkspaceRow.click();

  const created = await callBrowserTool(client, "browser_new_tab", { url: targetUrl });
  const browserId = created.browserId;
  assert(typeof browserId === "string", "browser_new_tab returned no browserId");

  const originalDeck = page.getByTestId(`workspace-deck-entry-${serverId}:${originalWorkspaceId}`);
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  await page.waitForFunction(
    (id) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return webview && webview.parentElement?.id !== "paseo-browser-resident-webviews";
    },
    browserId,
    { timeout: timeoutMs },
  );
  const firstGuest = await readGuest(page, browserId);
  assert(firstGuest, "Original browser guest was not attached to its workspace pane");

  for (const workspaceId of workspaceIds.slice(1)) {
    await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`).click();
    await page
      .getByTestId(`workspace-deck-entry-${serverId}:${workspaceId}`)
      .waitFor({ state: "visible" });
  }

  await page.waitForFunction(
    ({ id, previousWebContentsId }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview?.parentElement?.id === "paseo-browser-resident-webviews" &&
        typeof webview.getWebContentsId === "function" &&
        webview.getWebContentsId() !== previousWebContentsId
      );
    },
    { id: browserId, previousWebContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  const replacementGuest = await readGuest(page, browserId);
  assert(replacementGuest, "Replacement browser guest was not parked after workspace eviction");

  const listed = await callBrowserTool(client, "browser_list_tabs");
  assert(
    listed.tabs.some((tab) => tab.browserId === browserId),
    "browser_list_tabs lost the original tab after guest replacement",
  );

  const snapshot = await callBrowserTool(client, "browser_snapshot", { browserId });
  const ref = snapshot.snapshot.match(/button "Bridge target" \[ref=(@e\d+)\]/)?.[1];
  assert(ref, `browser_snapshot did not expose the target button: ${snapshot.snapshot}`);

  const clicked = await callBrowserTool(client, "browser_click", { browserId, ref });
  assert(
    clicked.browserId === browserId && clicked.ref === ref,
    "browser_click targeted another tab",
  );
  await callBrowserTool(client, "browser_wait", {
    browserId,
    text: "Clicked",
    timeoutMs: 5_000,
  });

  return {
    browserId,
    originalWebContentsId: firstGuest.webContentsId,
    replacementWebContentsId: replacementGuest.webContentsId,
    list: "passed",
    snapshot: "passed",
    click: "passed",
  };
}

async function main() {
  const artifactDir =
    process.env.PASEO_TAB_BRIDGE_E2E_ARTIFACT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "paseo-tab-bridge-e2e-artifacts-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-tab-bridge-e2e-"));
  fs.mkdirSync(artifactDir, { recursive: true });
  const paseoHome = path.join(runtimeDir, "paseo-home");
  const userData = path.join(runtimeDir, "electron-user-data");
  const workspaceRoot = path.join(runtimeDir, "workspaces");
  fs.mkdirSync(paseoHome, { recursive: true });

  const [daemonPort, expoPort, cdpPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const listen = `127.0.0.1:${daemonPort}`;
  seedPaseoHome(paseoHome, listen, workspaceRoot);
  const target = await startTargetPage();
  const children = [];
  let browser = null;
  let client = null;

  try {
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
    const daemon = spawnLogged(
      "daemon",
      process.execPath,
      ["--import", "tsx", path.join(rootDir, "packages/server/scripts/dev-runner.ts")],
      { cwd: rootDir, env: { ...commonEnv, PASEO_NODE_ENV: "development" } },
      artifactDir,
    );
    children.push(daemon.child);
    await waitForPort(daemonPort, "daemon", daemon);

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
      "desktop",
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
    const status = await waitForDesktopStatus(page);

    const callerAgentId = await createCallerAgent(daemonPort);
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${daemonPort}/mcp/agents?callerAgentId=${encodeURIComponent(callerAgentId)}`,
      ),
    );
    client = await experimental_createMCPClient({ transport });
    const report = await runRegression({
      page,
      client,
      serverId: status.serverId,
      targetUrl: target.url,
    });
    writeJson(path.join(artifactDir, "result.json"), report);
    console.log(
      `Browser tab bridge E2E passed: WebContents ${report.originalWebContentsId} -> ${report.replacementWebContentsId}; list, snapshot, click passed.`,
    );
  } catch (error) {
    console.error(`Browser tab bridge E2E failed. Artifacts: ${artifactDir}`);
    console.error(error);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    for (const child of children.toReversed()) stopProcess(child);
    await closeServer(target.server);
    await delay(1_000);
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`Failed to remove isolated E2E state ${runtimeDir}`, error);
    }
  }
}

await main();
