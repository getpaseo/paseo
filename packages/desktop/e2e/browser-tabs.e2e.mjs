#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
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
import { runAppearanceFontSizeRegression } from "./appearance-font-size.electron.mjs";
import { runSettingsMemoryRegression } from "./settings-memory.electron.mjs";

import { seedPluginLinks, runPluginLinksRegression } from "./plugin-links.electron.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const devRunner = path.join(desktopDir, "scripts", "dev-runner.mjs");
const workspaceIds = [
  "desktop-browser-original",
  "desktop-browser-evict-one",
  "desktop-browser-evict-two",
  "desktop-browser-evict-three",
];
const timeoutMs = 90_000;
const phase = process.env.PASEO_DESKTOP_BROWSER_E2E_PHASE ?? "after";
assert(["baseline", "after"].includes(phase), "Browser E2E phase must be baseline or after");

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
      displayName: `Desktop browser project ${index + 1}`,
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
    displayName: `Desktop browser workspace ${index + 1}`,
    title: `Desktop browser workspace ${index + 1}`,
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
      mcp: { enabled: true, injectIntoAgents: true },
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
  const httpLoadCounts = new Map();
  const pendingRequests = new Map();
  const server = createServer((request, response) => {
    const fixtureId = new URL(request.url, "http://localhost").searchParams.get("fixture");
    if (request.url.startsWith("/pending")) {
      pendingRequests.set(fixtureId, response);
      return;
    }
    // Count documents only; favicon requests must not look like guest reloads.
    const httpLoadCount = fixtureId ? (httpLoadCounts.get(fixtureId) ?? 0) + 1 : 0;
    if (fixtureId) httpLoadCounts.set(fixtureId, httpLoadCount);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const fixtureIndex = Number(fixtureId?.split("-").at(-1)) || 0;
    const background = fixtureId ? `hsl(${(fixtureIndex * 37) % 360}, 70%, 65%)` : "rgb(255, 0, 0)";
    response.end(`<!doctype html>
      <html>
        <head><title>Desktop browser target</title>
          <style>body { min-height: ${fixtureId ? "4000px" : "100vh"}; background: ${background}; }
          #fixture-marker { position: fixed; right: 24px; top: 24px; font: 48px monospace; }</style>
          <script>
            window.fixtureId = ${JSON.stringify(fixtureId)};
            window.httpLoadCount = ${httpLoadCount};
            const loadKey = "paseo-load-count:" + window.fixtureId;
            window.loadCount = Number(sessionStorage.getItem(loadKey) || 0) + 1;
            sessionStorage.setItem(loadKey, String(window.loadCount));
            window.frameCount = 0;
            function tick() { window.frameCount++; requestAnimationFrame(tick); }
            requestAnimationFrame(tick);
          </script>
        </head>
        <body>
          <button id="bridge-target" onclick="this.textContent = 'Clicked'">Bridge target</button>
          <label for="typing-target">Typing target</label>
          <input id="typing-target" />
          <div id="fixture-marker">${fixtureId ? `TAB ${fixtureIndex}` : ""}</div>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Target page did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}/`, httpLoadCounts, pendingRequests };
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

async function waitForGuestSelector(client, browserId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const evaluated = await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: "() => Boolean(globalThis.__paseoSelector)",
    });
    if (JSON.parse(evaluated.resultJson) === true) {
      return true;
    }
    await delay(50);
  }
  return false;
}

async function waitForGuestActiveElement(client, browserId, elementId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const evaluated = await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: "() => document.activeElement?.id ?? null",
    });
    if (JSON.parse(evaluated.resultJson) === elementId) {
      return true;
    }
    await delay(50);
  }
  return false;
}

async function createCallerAgent(daemonPort, workspaceId = workspaceIds[0]) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${daemonPort}/mcp/agents`),
  );
  const client = await experimental_createMCPClient({ transport });
  try {
    const response = await client.callTool({
      name: "create_agent",
      args: {
        relationship: { kind: "detached" },
        workspace: { kind: "existing", workspaceId },
        title: "Browser desktop browser E2E caller",
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
      result.workspaceId === workspaceId,
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
      width: Math.round(webview.getBoundingClientRect().width),
      height: Math.round(webview.getBoundingClientRect().height),
    };
  }, browserId);
}

async function readPresentation(page, browserId) {
  return await page.evaluate((id) => {
    const surface = document.querySelector(`[data-paseo-browser-surface="${id}"]`);
    const clip = document.querySelector(`[data-testid="browser-webview-clip-${id}"]`);
    if (!(surface instanceof HTMLElement) || !(clip instanceof HTMLElement)) return null;
    const surfaceRect = surface.getBoundingClientRect();
    const clipRect = clip.getBoundingClientRect();
    const webview = surface.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) return null;
    const webviewRect = webview.getBoundingClientRect();
    const outsidePoint = {
      x: Math.max(0, Math.round(clipRect.left - 1)),
      y: Math.round(clipRect.top + clipRect.height / 2),
    };
    const outsideTarget = document.elementFromPoint(outsidePoint.x, outsidePoint.y);
    return {
      surface: {
        left: Math.round(surfaceRect.left),
        top: Math.round(surfaceRect.top),
        right: Math.round(surfaceRect.right),
        bottom: Math.round(surfaceRect.bottom),
      },
      clip: {
        left: Math.round(clipRect.left),
        top: Math.round(clipRect.top),
        right: Math.round(clipRect.right),
        bottom: Math.round(clipRect.bottom),
      },
      webview: {
        left: Math.round(webviewRect.left),
        top: Math.round(webviewRect.top),
      },
      capturesOutsideInput: surface.contains(outsideTarget),
    };
  }, browserId);
}

async function readViewport(client, browserId) {
  const evaluated = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function:
      "() => ({ width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio })",
  });
  return JSON.parse(evaluated.resultJson);
}

async function clickGuestElement(page, client, browserId, selector) {
  const evaluated = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: `() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }`,
  });
  const elementRect = JSON.parse(evaluated.resultJson);
  assert(elementRect, `Guest element ${selector} was unavailable`);
  await page.locator(`[data-paseo-browser-id="${browserId}"]`).click({
    position: {
      x: elementRect.x + elementRect.width / 2,
      y: elementRect.y + elementRect.height / 2,
    },
  });
}

async function selectDeviceSize(page, label) {
  await page.locator('[aria-label="Device size"]').click();
  const item = page.getByText(label, { exact: true });
  await item.waitFor({ state: "visible", timeout: timeoutMs });
  const rect = await item.boundingBox();
  assert(rect, `Device size menu item ${label} had no bounds`);
  const clip = {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    width: rect.width,
    height: rect.height,
  };
  const openPixels = await page.screenshot({ clip });
  await page.keyboard.press("Escape");
  await item.waitFor({ state: "hidden", timeout: timeoutMs });
  const closedPixels = await page.screenshot({ clip });

  await page.locator('[aria-label="Device size"]').click();
  await item.waitFor({ state: "visible", timeout: timeoutMs });
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.press("Escape");
  return !openPixels.equals(closedPixels);
}

async function selectElementAndReadAnnotationPaint({ page, client, browserId, artifactDir }) {
  await clickGuestElement(page, client, browserId, "#bridge-target");
  const comment = page.getByRole("textbox", {
    name: "Message to the agent about this element…",
  });
  await comment.waitFor({ state: "visible", timeout: timeoutMs });
  const bounds = await comment.boundingBox();
  assert(bounds, "Element annotation comment box had no bounds");
  const receivesInput = await comment.evaluate((element) => {
    const elementBounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      elementBounds.left + elementBounds.width / 2,
      elementBounds.top + elementBounds.height / 2,
    );
    return target === element || element.contains(target);
  });
  const clip = {
    x: Math.max(0, bounds.x),
    y: Math.max(0, bounds.y),
    width: bounds.width,
    height: bounds.height,
  };
  const openPixels = await page.screenshot({
    clip,
    path: path.join(artifactDir, "element-annotation-open.png"),
  });
  await page.keyboard.press("Escape");
  await comment.waitFor({ state: "hidden", timeout: timeoutMs });
  const closedPixels = await page.screenshot({
    clip,
    path: path.join(artifactDir, "element-annotation-closed.png"),
  });
  return receivesInput && !openPixels.equals(closedPixels);
}

function recordViewportMismatch(failures, label, actual, expected) {
  if (actual.width === expected.width && actual.height === expected.height) {
    return;
  }
  failures.push(
    `${label}: expected ${expected.width}x${expected.height}, received ${actual.width}x${actual.height}`,
  );
}

async function evaluateMain(inspectorPort, expression) {
  const [target] = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Electron main evaluation timed out")),
        timeoutMs,
      );
      socket.addEventListener(
        "error",
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
        { once: true },
      );
      socket.addEventListener("message", ({ data }) => {
        const response = JSON.parse(data);
        if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.error || response.result?.exceptionDetails) reject(new Error(data));
        else resolve(response.result.result.value);
      });
      socket.addEventListener(
        "open",
        () =>
          socket.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression, awaitPromise: true, returnByValue: true },
            }),
          ),
        { once: true },
      );
    });
  } finally {
    socket.close();
  }
}

async function setWindowHidden(inspectorPort, hidden) {
  await evaluateMain(
    inspectorPort,
    `(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')); win.${hidden ? "hide" : "show"}(); if (win.isVisible() !== ${!hidden}) throw new Error('Window visibility did not change'); })()`,
  );
}

async function readScreenshotPixel(inspectorPort, screenshot) {
  const readPixel = `(async () => {
    const image = new Image();
    image.src = ${JSON.stringify(`data:image/png;base64,${screenshot.data}`)};
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data];
  })()`;
  const pixel = await evaluateMain(
    inspectorPort,
    `process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).webContents.executeJavaScript(${JSON.stringify(readPixel)})`,
  );
  return pixel;
}

async function verifyCaptureCancellation({
  client,
  browserId,
  webContentsId,
  inspectorPort,
  artifactDir,
}) {
  const ipcPath = path.join(desktopDir, "dist/features/browser-automation/ipc.js");
  const registryPath = path.join(desktopDir, "dist/features/browser-webviews/index.js");
  const cancel = await evaluateMain(
    inspectorPort,
    `(async () => {
    const wc = process.mainModule.require('electron').webContents.fromId(${webContentsId});
    const tab = process.mainModule.require(${JSON.stringify(ipcPath)}).adaptWebContents(wc);
    const controller = new AbortController();
    const primary = new Error('runtime capture cancellation');
    const send = wc.debugger.sendCommand;
    let native;
    let primaryPreserved = false;
    const start = performance.now();
    wc.debugger.sendCommand = function(command, params) {
      const pending = send.call(this, command, params);
      if (command === 'Page.captureScreenshot') { native = pending; queueMicrotask(() => controller.abort(primary)); }
      return pending;
    };
    try { await tab.captureFrame(controller.signal); }
    catch (error) { primaryPreserved = error === primary; }
    finally { wc.debugger.sendCommand = send; }
    let timeout;
    let recovery;
    try {
      const [, image] = await Promise.race([Promise.all([native, tab.captureFrame(new AbortController().signal)]), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Capture cancellation recovery exceeded 5 seconds')), 5000); })]);
      recovery = { size: image.getSize() };
    } catch (error) { recovery = { error: String(error) }; }
    finally { clearTimeout(timeout); }
    return { primaryPreserved, nativeStarted: Boolean(native), elapsedMs: performance.now() - start, recovery, id: wc.id, captured: wc.isBeingCaptured(), throttling: wc.getBackgroundThrottling() };
  })()`,
  );
  writeJson(path.join(artifactDir, "hidden-capture-cancellation.json"), cancel);
  assert(
    cancel.nativeStarted && cancel.primaryPreserved,
    "Capture cancellation lost its primary error",
  );
  assert(
    !cancel.recovery.error && !cancel.captured && cancel.id === webContentsId,
    `Native capture did not release after cancellation: ${JSON.stringify(cancel)}`,
  );
  const url = JSON.parse(
    (
      await callBrowserTool(client, "browser_evaluate", {
        browserId,
        function: "() => location.href",
      })
    ).resultJson,
  );
  const closing = await callBrowserTool(client, "browser_new_tab", { url });
  try {
    await callBrowserTool(client, "browser_wait", {
      browserId: closing.browserId,
      text: "Bridge target",
      timeoutMs: 5000,
    });
    const close = await evaluateMain(
      inspectorPort,
      `(async () => {
      const { BrowserWindow, webContents } = process.mainModule.require('electron');
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).webContents;
      const id = await host.executeJavaScript(${JSON.stringify(`document.querySelector('[data-paseo-browser-id="${closing.browserId}"]').getWebContentsId()`)});
      const wc = webContents.fromId(id);
      const tab = process.mainModule.require(${JSON.stringify(ipcPath)}).adaptWebContents(wc);
      const send = wc.debugger.sendCommand;
      let native;
      let errorName;
      const start = performance.now();
      wc.debugger.sendCommand = function(command, params) {
        const pending = send.call(this, command, params);
        if (command === 'Page.captureScreenshot') { native = pending.then(() => 'completed', error => String(error)); queueMicrotask(() => wc.close({ waitForBeforeUnload: false })); }
        return pending;
      };
      try { await tab.captureFrame(new AbortController().signal); }
      catch (error) { errorName = error.name; }
      let timeout;
      let nativeOutcome;
      try { nativeOutcome = await Promise.race([native, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Destroyed CDP capture did not settle')), 5000); })]); }
      catch (error) { nativeOutcome = String(error); }
      finally { clearTimeout(timeout); }
      const registry = process.mainModule.require(${JSON.stringify(registryPath)});
      return { id, errorName, nativeStarted: Boolean(native), nativeOutcome, elapsedMs: performance.now() - start, destroyed: wc.isDestroyed(), fromIdAbsent: !webContents.fromId(id), absentFromAll: !webContents.getAllWebContents().some(contents => contents.id === id), registryAbsent: !registry.getPaseoBrowserWebContentsForHostWindow(${JSON.stringify(closing.browserId)}, host.id) };
    })()`,
    );
    writeJson(path.join(artifactDir, "hidden-capture-destruction.json"), close);
    assert(
      close.nativeStarted &&
        close.destroyed &&
        close.errorName === "BrowserTabClosedError" &&
        close.fromIdAbsent &&
        close.absentFromAll &&
        close.registryAbsent,
      `Capture destruction retained guest resources: ${JSON.stringify(close)}`,
    );
  } finally {
    await callBrowserTool(client, "browser_close_tab", { browserId: closing.browserId });
  }
  await callBrowserTool(client, "browser_screenshot", { browserId });
  const surviving = await evaluateMain(
    inspectorPort,
    `(() => { const wc = process.mainModule.require('electron').webContents.fromId(${webContentsId}); return { id: wc.id, captured: wc.isBeingCaptured(), destroyed: wc.isDestroyed() }; })()`,
  );
  writeJson(path.join(artifactDir, "hidden-capture-surviving-guest.json"), surviving);
  assert(
    surviving.id === webContentsId && !surviving.captured && !surviving.destroyed,
    `Surviving capture did not release: ${JSON.stringify(surviving)}`,
  );
}

async function verifyHiddenBrowserScreenshots({
  page,
  client,
  browserId,
  artifactDir,
  inspectorPort,
  reconnect,
}) {
  const readFrames = async () => {
    const result = await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: "() => window.frameCount",
    });
    return JSON.parse(result.resultJson);
  };
  const expectAnimation = async () => {
    const start = await readFrames();
    assert(typeof start === "number", "Animation fixture was not loaded");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await readFrames()) > start + 2) return;
      await delay(50);
    }
    throw new Error("Browser did not animate in the restored window");
  };
  const measurements = [];
  const expectIdle = async (label) => {
    await delay(500); // Let Chromium consume the visibility change before sampling.
    const start = await readFrames();
    await delay(1_000); // A fixed sampling interval is the behavior under test.
    const frames = (await readFrames()) - start;
    measurements.push({ label, frames });
    writeJson(path.join(artifactDir, "hidden-browser-frames.json"), measurements);
    assert(frames === 0, `${label}: hidden browser produced ${frames} animation frames`);
  };
  const originalGuest = await readGuest(page, browserId);
  const referencePixels = [];
  const fullPageReferencePixels = [];
  for (const color of ["rgb(0,255,0)", "rgb(255,0,0)"]) {
    await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: `() => { document.body.style.background = ${JSON.stringify(color)}; }`,
    });
    const reference = await client.callTool({ name: "browser_screenshot", args: { browserId } });
    mcpPayload(reference, "browser_screenshot");
    const screenshot = reference.content.find((item) => item.type === "image");
    assert(screenshot, "Visible reference screenshot returned no image");
    referencePixels.push(await readScreenshotPixel(inspectorPort, screenshot));
    const fullPage = await client.callTool({
      name: "browser_screenshot",
      args: { browserId, fullPage: true },
    });
    mcpPayload(fullPage, "browser_screenshot");
    const fullPageImage = fullPage.content.find((item) => item.type === "image");
    assert(fullPageImage, "Full-page reference returned no image");
    fullPageReferencePixels.push(await readScreenshotPixel(inspectorPort, fullPageImage));
  }
  const [greenPixel, redPixel] = referencePixels;
  writeJson(path.join(artifactDir, "hidden-browser-reference-pixels.json"), {
    greenPixel,
    redPixel,
  });
  assert(
    JSON.stringify(greenPixel) !== JSON.stringify(redPixel),
    "Reference captures did not distinguish red and green",
  );
  let reconnectedPage;
  const readVisibility = () =>
    evaluateMain(
      inspectorPort,
      `(async () => { const { app, BrowserWindow, webContents } = process.mainModule.require('electron'); return {
      colorProfile: app.commandLine.getSwitchValue('force-color-profile'),
      windows: BrowserWindow.getAllWindows().map(win => ({ id: win.id, visible: win.isVisible(), minimized: win.isMinimized(), webContentsId: win.webContents.id })),
      contents: await Promise.all(webContents.getAllWebContents().map(async wc => ({ id: wc.id, type: wc.getType(), debuggerAttached: wc.debugger.isAttached(), captured: wc.isBeingCaptured(), backgroundThrottling: wc.getBackgroundThrottling(), visibility: await wc.executeJavaScript('document.visibilityState') })))
    }; })()`,
    );
  try {
    await expectAnimation();
    // Playwright's attached host session keeps hidden guests animating; sample native visibility without it.
    await page.context().browser().close();
    await setWindowHidden(inspectorPort, true);
    const nativeStates = { atHide: await readVisibility() };
    writeJson(path.join(artifactDir, "hidden-browser-native-state.json"), nativeStates);
    await expectIdle("before-capture");
    nativeStates.beforeCapture = await readVisibility();
    writeJson(path.join(artifactDir, "hidden-browser-native-state.json"), nativeStates);
    await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: "() => { document.body.style.background = 'rgb(0,255,0)'; }",
    });
    const response = await client.callTool({ name: "browser_screenshot", args: { browserId } });
    mcpPayload(response, "browser_screenshot");
    const screenshot = response.content.find((item) => item.type === "image");
    assert(screenshot, "browser_screenshot returned no image");
    fs.writeFileSync(
      path.join(artifactDir, "hidden-browser-viewport.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    nativeStates.afterCapture = await readVisibility();
    writeJson(path.join(artifactDir, "hidden-browser-native-state.json"), nativeStates);
    const pixel = await readScreenshotPixel(inspectorPort, screenshot);
    nativeStates.afterPixelDecoder = await readVisibility();
    writeJson(path.join(artifactDir, "hidden-browser-native-state.json"), nativeStates);
    assert(
      JSON.stringify(pixel) === JSON.stringify(greenPixel) &&
        JSON.stringify(pixel) !== JSON.stringify(redPixel),
      `Hidden screenshot returned stale pixels: ${pixel}; expected green ${greenPixel}, not red ${redPixel}`,
    );
    writeJson(path.join(artifactDir, "hidden-browser-reference-pixels.json"), {
      greenPixel,
      redPixel,
      hiddenPixel: pixel,
    });
    await expectIdle("after-capture");
    await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: "() => { document.body.style.background = 'rgb(255,0,0)'; }",
    });
    const fullPage = await client.callTool({
      name: "browser_screenshot",
      args: { browserId, fullPage: true },
    });
    mcpPayload(fullPage, "browser_screenshot");
    const fullPageImage = fullPage.content.find((item) => item.type === "image");
    assert(fullPageImage, "Hidden full-page capture returned no image");
    fs.writeFileSync(
      path.join(artifactDir, "hidden-browser-full-page.png"),
      Buffer.from(fullPageImage.data, "base64"),
    );
    const fullPagePixel = await readScreenshotPixel(inspectorPort, fullPageImage);
    writeJson(path.join(artifactDir, "hidden-browser-full-page-pixels.json"), {
      references: fullPageReferencePixels,
      hidden: fullPagePixel,
    });
    assert(
      JSON.stringify(fullPagePixel) === JSON.stringify(fullPageReferencePixels[1]) &&
        JSON.stringify(fullPagePixel) !== JSON.stringify(fullPageReferencePixels[0]),
      "Hidden full-page screenshot returned stale pixels",
    );
    await expectIdle("after-full-page-capture");
    await verifyCaptureCancellation({
      client,
      browserId,
      webContentsId: originalGuest.webContentsId,
      inspectorPort,
      artifactDir,
    });
    await expectIdle("after-capture-cancellation-and-destruction");
    nativeStates.afterRecovery = await readVisibility();
    writeJson(path.join(artifactDir, "hidden-browser-native-state.json"), nativeStates);
  } finally {
    await setWindowHidden(inspectorPort, false);
    reconnectedPage = await reconnect();
  }
  await expectAnimation();
  assert(
    (await readGuest(reconnectedPage, browserId)).webContentsId === originalGuest.webContentsId,
    "Observer reconnect replaced browser WebContents",
  );
  return reconnectedPage;
}

async function verifyBackgroundTypingStaysInGuest({ page, client, serverId, browserId, agent }) {
  await page
    .getByTestId(`workspace-deck-entry-${serverId}:${agent.workspaceId}`)
    .getByTestId(`workspace-tab-agent_${agent.agentId}`)
    .click({ timeout: timeoutMs });
  const composer = page
    .getByRole("textbox", { name: "Message agent..." })
    .filter({ visible: true })
    .first();
  const draft = "draft the user is typing";
  await composer.click();
  await composer.pressSequentially(draft);
  assert(
    await composer.evaluate((element) => element === document.activeElement),
    "Composer did not keep focus while the user typed",
  );

  const snapshot = await callBrowserTool(client, "browser_snapshot", { browserId });
  const ref = snapshot.snapshot.match(/textbox "Typing target" \[ref=(@e\d+)\]/)?.[1];
  assert(ref, `browser_snapshot did not expose the typing target: ${snapshot.snapshot}`);
  await callBrowserTool(client, "browser_type", { browserId, ref, text: "agent text" });
  await callBrowserTool(client, "browser_keypress", { browserId, ref, key: "!" });

  // The user keeps typing in the composer while the agent types into the tab's focused field.
  await composer.click();
  await composer.press("End");
  assert(
    await composer.evaluate((element) => element === document.activeElement),
    "Composer did not take focus back from the browser tab",
  );
  await callBrowserTool(client, "browser_type", { browserId, text: " more" });
  await callBrowserTool(client, "browser_keypress", { browserId, key: "?" });

  const guestValue = JSON.parse(
    (
      await callBrowserTool(client, "browser_evaluate", {
        browserId,
        function: "() => document.getElementById('typing-target').value",
      })
    ).resultJson,
  );
  const composerValue = await composer.inputValue();
  assert(
    composerValue === draft,
    `browser_type and browser_keypress in a background tab changed the focused composer: ${JSON.stringify(composerValue)}`,
  );
  assert(
    guestValue === "agent text! more?",
    `browser_type and browser_keypress did not reach the browser tab: ${JSON.stringify(guestValue)}`,
  );
  await composer.fill("");
}

async function runRegression({
  page,
  client,
  serverId,
  targetUrl,
  callerAgentId,
  typingAgent,
  artifactDir,
  inspectorPort,
  reconnect,
}) {
  const failures = [];
  const originalWorkspaceId = workspaceIds[0];
  let originalWorkspaceRow = page.getByTestId(
    `sidebar-workspace-row-${serverId}:${originalWorkspaceId}`,
  );
  await originalWorkspaceRow.waitFor({ state: "visible", timeout: timeoutMs });
  await originalWorkspaceRow.click();

  await page.evaluate(() => {
    if (document.getElementById("overlay-root")) return;
    const overlayRoot = document.createElement("div");
    overlayRoot.id = "overlay-root";
    overlayRoot.style.position = "fixed";
    overlayRoot.style.inset = "0";
    overlayRoot.style.pointerEvents = "none";
    document.body.appendChild(overlayRoot);
  });

  const created = await callBrowserTool(client, "browser_new_tab", { url: targetUrl });
  const browserId = created.browserId;
  assert(typeof browserId === "string", "browser_new_tab returned no browserId");

  let originalDeck = page.getByTestId(`workspace-deck-entry-${serverId}:${originalWorkspaceId}`);
  await revealBrowserForAfter(originalDeck);
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  if (phase === "after") {
    const browserRow = originalDeck.getByRole("tablist", { name: "Browser tabs", exact: true });
    await browserRow.getByRole("button", { name: "New browser tab", exact: true }).click();
    const address = page
      .getByRole("textbox", { name: "Address", exact: true })
      .filter({ visible: true });
    assert((await address.inputValue()) === "", "New tab must show an empty address");
    assert(
      await address.evaluate((element) => document.activeElement === element),
      "New tab must focus the address before typing",
    );
    const blankTestId = await browserRow
      .getByRole("tab", { selected: true })
      .getAttribute("data-testid");
    assert(blankTestId, "Blank tab must have an identity");
    await page.waitForFunction(
      (id) => {
        const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
        return webview && webview.getWebContentsId() > 0 && !webview.isLoading();
      },
      blankTestId.replace("workspace-tab-browser_", ""),
    );
    assert(
      await address.evaluate((el) => el === document.activeElement),
      "Guest attachment stole the blank address focus",
    );
    await page.screenshot({ path: path.join(artifactDir, "browser-new-empty.png") });
    await address.press("Enter");
    assert((await address.inputValue()) === "", "Empty address submission must remain blank");
    await address.fill(targetUrl);
    await address.press("Enter");
    assert(
      (await browserRow.getByRole("tab", { selected: true }).count()) === 1,
      "Browser row must have exactly one selected tab",
    );
    const manualTab = browserRow.getByRole("tab", { selected: true });
    const manualTabTestId = await manualTab.getAttribute("data-testid");
    await hideBrowserForAfter(originalDeck);
    await revealBrowserForAfter(originalDeck);
    await address.waitFor({ state: "visible" });
    assert(
      await address.evaluate((element) => document.activeElement !== element),
      "Revealing a used manual tab must not replay its initial address focus",
    );
    await manualTab.focus();
    await manualTab.press("Home");
    assert(
      await browserRow
        .getByRole("tab")
        .first()
        .evaluate((element) => document.activeElement === element),
      "Home must keep focus on the first browser tab",
    );
    await browserRow.getByRole("tab").first().press("End");
    assert(
      await browserRow
        .getByRole("tab")
        .last()
        .evaluate((element) => document.activeElement === element),
      "End must keep focus on the last browser tab",
    );
    await browserRow.getByRole("tab").last().press("ArrowLeft");
    assert(
      await browserRow
        .getByRole("tab")
        .first()
        .evaluate((element) => document.activeElement === element),
      "ArrowLeft must keep focus in the browser row",
    );
    await browserRow.getByRole("tab").first().press("ArrowRight");
    assert(
      await browserRow
        .getByRole("tab")
        .last()
        .evaluate((element) => document.activeElement === element),
      "ArrowRight must keep focus in the browser row",
    );
    assert(manualTabTestId, "Manual browser tab must have a stable test id");
    await originalDeck
      .getByTestId(manualTabTestId.replace("workspace-tab-browser_", "workspace-browser-close-"))
      .click();
    await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  }

  await page.waitForFunction(
    (id) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      const surface = webview?.parentElement;
      return (
        surface?.getAttribute("aria-hidden") === "false" && surface.style.pointerEvents === "auto"
      );
    },
    browserId,
    { timeout: timeoutMs },
  );
  const firstGuest = await readGuest(page, browserId);
  assert(firstGuest, "Original browser guest was not attached to its workspace pane");
  recordViewportMismatch(
    failures,
    "Responsive viewport follows the visible browser pane",
    await readViewport(client, browserId),
    { width: firstGuest.width, height: firstGuest.height },
  );

  await clickGuestElement(page, client, browserId, "#typing-target");
  assert(
    await waitForGuestActiveElement(client, browserId, "typing-target"),
    "Physical browser click did not focus the guest input",
  );
  const focusedGuest = await page.evaluate(
    (id) => window.paseoDesktop?.browser?.focus?.(id),
    browserId,
  );
  assert(focusedGuest === true, "Electron did not focus the registered browser guest");

  const deviceSizeMenuPainted = await selectDeviceSize(page, "iPhone SE · 375×667");
  assert(deviceSizeMenuPainted, "Device size menu did not paint above the browser surface");
  const deviceViewport = await readViewport(client, browserId);
  recordViewportMismatch(
    failures,
    "device size menu paints and receives input above the browser surface",
    deviceViewport,
    { width: 375, height: 667 },
  );

  await callBrowserTool(client, "browser_wait", {
    browserId,
    text: "Bridge target",
    timeoutMs: 5_000,
  });
  const resizedScreenshot = await callBrowserTool(client, "browser_screenshot", { browserId });
  assert(
    resizedScreenshot.width === Math.round(375 * deviceViewport.scale) &&
      resizedScreenshot.height === Math.round(667 * deviceViewport.scale),
    `Screenshot after resize returned ${resizedScreenshot.width}×${resizedScreenshot.height}`,
  );
  const requestedViewport = { width: 640, height: 480 };
  await callBrowserTool(client, "browser_resize", { browserId, ...requestedViewport });
  recordViewportMismatch(
    failures,
    "browser_resize updates the visible shared viewport",
    await readViewport(client, browserId),
    requestedViewport,
  );

  const oversizedViewport = { width: 2560, height: 1440 };
  await callBrowserTool(client, "browser_resize", { browserId, ...oversizedViewport });
  recordViewportMismatch(
    failures,
    "oversized preset preserves the requested guest viewport",
    await readViewport(client, browserId),
    oversizedViewport,
  );
  await page.waitForFunction(
    ({ id, width, height }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview instanceof HTMLElement &&
        Math.round(webview.getBoundingClientRect().width) === width &&
        Math.round(webview.getBoundingClientRect().height) === height
      );
    },
    { id: browserId, ...oversizedViewport },
    { timeout: timeoutMs },
  );
  const presentation = await readPresentation(page, browserId);
  assert(presentation, "Oversized browser presentation geometry was unavailable");
  if (
    presentation.surface.left < presentation.clip.left ||
    presentation.surface.top < presentation.clip.top ||
    presentation.surface.right > presentation.clip.right ||
    presentation.surface.bottom > presentation.clip.bottom
  ) {
    failures.push(
      `oversized browser surface stays inside its pane: ${JSON.stringify(presentation)}`,
    );
  }
  if (presentation.capturesOutsideInput) {
    failures.push("oversized browser surface captures input outside its pane");
  }
  await callBrowserTool(client, "browser_resize", { browserId, ...oversizedViewport });
  const repeatedResizePresentation = await readPresentation(page, browserId);
  assert(repeatedResizePresentation, "Repeated resize presentation geometry was unavailable");
  if (
    repeatedResizePresentation.webview.left !== presentation.webview.left ||
    repeatedResizePresentation.webview.top !== presentation.webview.top
  ) {
    failures.push(
      `repeating an oversized resize preserves the guest offset: before ${JSON.stringify(presentation.webview)}, after ${JSON.stringify(repeatedResizePresentation.webview)}`,
    );
  }
  await callBrowserTool(client, "browser_resize", { browserId, ...requestedViewport });

  await selectDeviceSize(page, "Responsive");
  const responsiveViewport = await readViewport(client, browserId);

  await originalDeck.getByTestId(`workspace-tab-agent_${callerAgentId}`).click();
  await hideBrowserForAfter(originalDeck);
  await page.waitForFunction(
    ({ id, webContentsId }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview?.parentElement?.getAttribute("data-paseo-browser-surface") === id &&
        webview.parentElement.style.width === "1px" &&
        webview.parentElement.style.pointerEvents === "none" &&
        webview.getWebContentsId() === webContentsId
      );
    },
    { id: browserId, webContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  try {
    await callBrowserTool(client, "browser_screenshot", { browserId });
  } catch (error) {
    failures.push(`inactive browser remains captureable: ${String(error)}`);
  }
  recordViewportMismatch(
    failures,
    "inactive browser preserves the shared viewport",
    await readViewport(client, browserId),
    responsiveViewport,
  );
  const focusContinuitySentinel = "preserve-browser-document-across-focus";
  await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: `() => {
      globalThis.__paseoFocusContinuity = ${JSON.stringify(focusContinuitySentinel)};
      globalThis.__paseoViewportTransitions = [{ width: innerWidth, height: innerHeight }];
      addEventListener('resize', () => {
        globalThis.__paseoViewportTransitions.push({ width: innerWidth, height: innerHeight });
      });
      return globalThis.__paseoFocusContinuity;
    }`,
  });
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!webview) throw new Error(`Browser webview ${id} was unavailable`);
    const events = [];
    globalThis.__paseoBrowserReactivationEvents = events;
    for (const name of [
      "did-start-loading",
      "did-navigate-in-page",
      "load-commit",
      "did-stop-loading",
    ]) {
      webview.addEventListener(name, (event) => {
        events.push({
          name,
          url: event.url ?? null,
          isMainFrame: event.isMainFrame ?? null,
        });
      });
    }
  }, browserId);

  await revealBrowserForAfter(originalDeck);
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  await page.waitForFunction(
    ({ id, webContentsId }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview?.parentElement?.getAttribute("data-paseo-browser-surface") === id &&
        webview.parentElement.style.pointerEvents === "auto" &&
        webview.getWebContentsId() === webContentsId
      );
    },
    { id: browserId, webContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(1_500);
  const reactivationEvents = await page.evaluate(
    () => globalThis.__paseoBrowserReactivationEvents ?? [],
  );
  const unexpectedReactivationCommits = reactivationEvents.filter(
    (event) => event.name === "did-navigate-in-page" || event.name === "load-commit",
  );
  assert(
    unexpectedReactivationCommits.length === 0,
    `responsive browser reactivation committed the current document: ${JSON.stringify(unexpectedReactivationCommits)}`,
  );
  const viewportTransitionsResult = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => globalThis.__paseoViewportTransitions ?? []",
  });
  const viewportTransitions = JSON.parse(viewportTransitionsResult.resultJson);
  const collapsedViewport = viewportTransitions.find(
    (viewport) => viewport.width <= 1 || viewport.height <= 1,
  );
  assert(
    collapsedViewport === undefined,
    `responsive browser reactivation collapsed the guest viewport: ${JSON.stringify(viewportTransitions)}`,
  );
  const continuityResult = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => globalThis.__paseoFocusContinuity ?? null",
  });
  const continuityValue = JSON.parse(continuityResult.resultJson);
  if (continuityValue !== focusContinuitySentinel) {
    failures.push(
      `focusing the browser tab preserves the current document: expected ${JSON.stringify(focusContinuitySentinel)}, received ${JSON.stringify(continuityValue)}`,
    );
  }

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
        webview?.parentElement?.getAttribute("data-paseo-browser-surface") === id &&
        webview.parentElement.style.width === "1px" &&
        typeof webview.getWebContentsId === "function" &&
        webview.getWebContentsId() === previousWebContentsId
      );
    },
    { id: browserId, previousWebContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  const parkedGuest = await readGuest(page, browserId);
  assert(parkedGuest, "Browser guest was not parked after workspace eviction");

  page = await verifyHiddenBrowserScreenshots({
    page,
    client,
    browserId,
    artifactDir,
    inspectorPort,
    reconnect,
  });
  originalWorkspaceRow = page.getByTestId(
    `sidebar-workspace-row-${serverId}:${originalWorkspaceId}`,
  );
  originalDeck = page.getByTestId(`workspace-deck-entry-${serverId}:${originalWorkspaceId}`);

  const listed = await callBrowserTool(client, "browser_list_tabs");
  assert(
    listed.tabs.some((tab) => tab.browserId === browserId),
    "browser_list_tabs lost the original tab after workspace eviction",
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
  await verifyBackgroundTypingStaysInGuest({
    page,
    client,
    serverId,
    browserId,
    agent: typingAgent,
  });

  await originalWorkspaceRow.click();
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  await page.waitForFunction(
    ({ id, webContentsId }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview?.parentElement?.getAttribute("data-paseo-browser-surface") === id &&
        webview.parentElement.style.pointerEvents === "auto" &&
        webview.getWebContentsId() === webContentsId
      );
    },
    { id: browserId, webContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  recordViewportMismatch(
    failures,
    "browser viewport survives workspace eviction and reattachment",
    await readViewport(client, browserId),
    responsiveViewport,
  );

  const annotateButton = originalDeck.getByRole("button", { name: "Annotate element" });
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) throw new Error(`Browser webview ${id} was unavailable`);
    globalThis.__paseoOriginalIsLoadingDescriptor = Object.getOwnPropertyDescriptor(
      webview,
      "isLoading",
    );
    Object.defineProperty(webview, "isLoading", {
      configurable: true,
      value: () => true,
    });
  }, browserId);
  await annotateButton.click();
  await page.waitForTimeout(100);
  assert(
    !(await originalDeck.getByRole("button", { name: "Cancel element selector" }).isVisible()),
    "Element selector started while the guest reported a genuine load",
  );
  const selectorDuringLoad = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => Boolean(globalThis.__paseoSelector)",
  });
  assert(
    JSON.parse(selectorDuringLoad.resultJson) === false,
    "Selector injected while the guest reported a genuine load",
  );
  assert(
    await page.getByText("Wait for the page to finish loading").isVisible(),
    "Element selector loading failure was not visible",
  );
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) throw new Error(`Browser webview ${id} was unavailable`);
    const descriptor = globalThis.__paseoOriginalIsLoadingDescriptor;
    if (descriptor) Object.defineProperty(webview, "isLoading", descriptor);
    else delete webview.isLoading;
    delete globalThis.__paseoOriginalIsLoadingDescriptor;
  }, browserId);

  const readyStateResult = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => document.readyState",
  });
  assert(
    JSON.parse(readyStateResult.resultJson) === "complete",
    "Local browser document did not finish loading",
  );
  // Reproduce the report's mismatch: the guest is complete, but the pane's
  // last loading signal says it is not ready.
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) {
      throw new Error(`Browser webview ${id} was unavailable`);
    }
    webview.dispatchEvent(new Event("did-start-loading"));
  }, browserId);

  await annotateButton.click();
  const annotateSelectorActive = await waitForGuestSelector(client, browserId);
  await page.screenshot({ path: path.join(artifactDir, "local-page-annotate-selector.png") });
  if (!annotateSelectorActive) {
    failures.push("loaded local browser remains ready for element annotation");
  }

  await originalDeck.getByRole("button", { name: "Cancel element selector" }).click();
  await delay(10_000);
  const screenshotButton = originalDeck.getByRole("button", { name: "Screenshot element" });
  await screenshotButton.click();
  const screenshotSelectorActive = await waitForGuestSelector(client, browserId);
  if (!screenshotSelectorActive) {
    failures.push("loaded local browser remains ready for element screenshots");
  }
  await delay(20_500);
  const selectorAfterPriorTimeout = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => Boolean(globalThis.__paseoSelector)",
  });
  if (JSON.parse(selectorAfterPriorTimeout.resultJson) !== true) {
    failures.push("a previous selector timeout does not destroy the current selector session");
  }
  await page.screenshot({ path: path.join(artifactDir, "local-page-screenshot-selector.png") });
  await originalDeck.getByRole("button", { name: "Cancel element selector" }).click();

  await originalDeck.getByTestId(`workspace-tab-agent_${callerAgentId}`).click();
  const rowCountBeforeSplit = await originalDeck
    .getByTestId("workspace-tabs-row")
    .filter({ visible: true })
    .count();
  await page.getByTestId("sidebar-search").click();
  await page.getByTestId("command-center-input").fill("Split pane right");
  await page.getByText("Split pane right", { exact: true }).click();
  assert(
    (await originalDeck.getByTestId("workspace-tabs-row").filter({ visible: true }).count()) ===
      rowCountBeforeSplit + 1,
    "Split pane command did not add one ordinary pane",
  );
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).last().click();
  await originalDeck
    .getByTestId(`browser-webview-clip-${browserId}`)
    .waitFor({ state: "visible", timeout: timeoutMs });

  const splitAnnotateButton = originalDeck.getByRole("button", { name: "Annotate element" });
  await splitAnnotateButton.click();
  assert(
    await waitForGuestSelector(client, browserId),
    "Element selector did not start in the split browser pane",
  );
  assert(
    await selectElementAndReadAnnotationPaint({
      page,
      client,
      browserId,
      artifactDir,
    }),
    "Element annotation comment box did not paint or receive input above the browser surface",
  );

  if (failures.length > 0) {
    throw new Error(`Browser viewport regressions:\n- ${failures.join("\n- ")}`);
  }

  return {
    browserId,
    originalWebContentsId: firstGuest.webContentsId,
    finalWebContentsId: parkedGuest.webContentsId,
    viewport: "passed",
    guestFocus: "passed",
    overlayPlane: "passed",
    inactiveCapture: "passed",
    hiddenWindowCapture: "passed",
    list: "passed",
    snapshot: "passed",
    click: "passed",
    localPageSelectors: "passed",
  };
}

async function readContinuity(page, client, browserId) {
  const guest = await readGuest(page, browserId);
  const state = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function:
      "() => ({ inputValue: document.querySelector('#typing-target').value, scrollY, loadCount, httpLoadCount, fixtureId })",
  });
  return { ...guest, ...JSON.parse(state.resultJson) };
}

async function verifyPresentationContinuity({
  page,
  client,
  serverId,
  callerAgentId,
  target,
  artifactDir,
  inspectorPort,
}) {
  const workspaceKey = `${serverId}:${workspaceIds[0]}`;
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  const deck = page.getByTestId(`workspace-deck-entry-${workspaceKey}`);
  await deck.getByTestId(`workspace-tab-agent_${callerAgentId}`).click();
  const composer = deck
    .getByRole("textbox", { name: "Message agent..." })
    .filter({ visible: true })
    .first();
  const layoutState = () =>
    page.evaluate((key) => {
      const state = JSON.parse(localStorage.getItem("workspace-layout-state")).state;
      return {
        layout: state.layoutByWorkspace[key],
        browserPaneId: state.browserPaneIdByWorkspace[key] ?? null,
      };
    }, workspaceKey);
  const initial = await layoutState();
  assert(initial.browserPaneId === null, "First background open must start without a browser pane");
  await composer.click();
  await composer.pressSequentially("conversation draft preserved");
  const composerBefore = await composer.evaluate((el) => {
    globalThis.__presentationComposer = el;
    globalThis.__presentationComposerEvents = [];
    for (const type of ["focus", "blur", "select"])
      el.addEventListener(type, () =>
        globalThis.__presentationComposerEvents.push({
          type,
          start: el.selectionStart,
          end: el.selectionEnd,
          time: performance.now(),
        }),
      );
    return {
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
      width: el.getBoundingClientRect().width,
    };
  });
  const created = await callBrowserTool(client, "browser_new_tab", {
    url: `${target.url}?fixture=presentation-0`,
  });
  const browserId = created.browserId;
  const background = await layoutState();
  assert(
    background.layout.focusedPaneId === initial.layout.focusedPaneId,
    "First agent browser stole pane focus",
  );
  assert(
    await composer.evaluate((el) => el === document.activeElement),
    "First agent browser stole composer DOM focus",
  );
  const composerAfter = await composer.evaluate((el) => ({
    value: el.value,
    start: el.selectionStart,
    end: el.selectionEnd,
    width: el.getBoundingClientRect().width,
    sameElement: el === globalThis.__presentationComposer,
    originalConnected: globalThis.__presentationComposer.isConnected,
    events: globalThis.__presentationComposerEvents,
  }));
  writeJson(path.join(artifactDir, "first-background-composer.json"), {
    before: composerBefore,
    after: composerAfter,
    initialLayout: initial,
    backgroundLayout: background,
  });
  assert(
    composerAfter.sameElement && composerAfter.originalConnected,
    "First background browser remounted the composer",
  );
  assert(
    composerAfter.start === composerBefore.start && composerAfter.end === composerBefore.end,
    "First background browser moved the caret",
  );
  assert(
    composerAfter.width === composerBefore.width,
    "First agent browser changed visible composer width",
  );
  await composer.pressSequentially(" while agent opens");
  const draft = await composer.inputValue();
  assert(
    draft === "conversation draft preserved while agent opens",
    `First browser interrupted typing: ${JSON.stringify(draft)}`,
  );
  assert(
    await deck.getByRole("button", { name: "Show browser", exact: true }).isVisible(),
    "Agent browser must remain hidden",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-hidden.png") });
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  const row = deck.getByRole("tablist", { name: "Browser tabs", exact: true });
  await row.getByTestId(`workspace-tab-browser_${browserId}`).click();
  await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function:
      "() => { document.querySelector('#typing-target').value = 'page form preserved'; sessionStorage.setItem('presentation-session', 'kept'); scrollTo(0, 640); return true; }",
  });
  await delay(100);
  const before = await readContinuity(page, client, browserId);
  const sharedLayout = await layoutState();
  const splitSizes = (node) =>
    node.kind === "pane" ? [] : [node.group.sizes, ...node.group.children.flatMap(splitSizes)];
  const originalSizes = JSON.stringify(splitSizes(sharedLayout.layout.root));
  const report = { before, transitions: [] };
  const check = async (label) => {
    const current = await readContinuity(page, client, browserId);
    for (const key of ["webContentsId", "inputValue", "scrollY", "loadCount", "httpLoadCount"]) {
      assert(
        current[key] === before[key],
        `${label} changed ${key}: ${current[key]} vs ${before[key]}`,
      );
    }
    const session = await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: "() => sessionStorage.getItem('presentation-session')",
    });
    assert(JSON.parse(session.resultJson) === "kept", `${label} lost local session`);
    const composerState = await page.evaluate(() => ({
      value: globalThis.__presentationComposer.value,
      connected: globalThis.__presentationComposer.isConnected,
    }));
    assert(
      composerState.connected && composerState.value === draft,
      `${label} lost conversation DOM or draft`,
    );
    const state = await layoutState();
    assert(
      JSON.stringify(splitSizes(state.layout.root)) === originalSizes,
      `${label} changed persisted split sizes`,
    );
    report.transitions.push({ label, ...current });
    writeJson(path.join(artifactDir, "presentation-continuity.json"), report);
  };
  await page.screenshot({ path: path.join(artifactDir, "browser-shared.png") });
  await deck.getByRole("button", { name: "Hide browser", exact: true }).click();
  await check("hidden");
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  await check("revealed");
  await row.getByTestId("workspace-maximize-pane").click();
  await check("maximized");
  await page.screenshot({ path: path.join(artifactDir, "browser-maximized.png") });
  const extra = await callBrowserTool(client, "browser_new_tab", {
    url: `${target.url}?fixture=presentation-1`,
  });
  assert(
    await row.getByTestId("workspace-restore-pane").isVisible(),
    "Background open exited maximize",
  );
  await check("background-open-while-maximized");
  await callBrowserTool(client, "browser_close_tab", { browserId: extra.browserId });
  await page.getByTestId("sidebar-search").click();
  await page.getByTestId("command-center-input").fill("Browser desktop browser E2E caller");
  await page.getByTestId(`command-center-agent-${serverId}:${callerAgentId}`).click();
  assert(
    await composer.isVisible(),
    "User reveal of already-selected conversation retained browser maximize",
  );
  assert(
    await row.getByTestId("workspace-maximize-pane").isVisible(),
    "User reveal did not clear local maximization",
  );
  await check("user-reveal-selected-conversation");
  await row.getByTestId("workspace-maximize-pane").click();
  await row.getByTestId("workspace-restore-pane").click();
  await check("restored");
  await row.getByTestId("workspace-maximize-pane").click();
  await deck.getByRole("button", { name: "Hide browser", exact: true }).click();
  await check("hidden-from-maximize");
  assert(await composer.isVisible(), "Hide from maximize left the conversation blank");
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  assert(
    await row.getByTestId("workspace-maximize-pane").isVisible(),
    "Reveal retained stale maximize",
  );
  await evaluateMain(
    inspectorPort,
    `(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')); win.minimize(); })()`,
  );
  const nativeWindowStates = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const minimized = await evaluateMain(
      inspectorPort,
      `process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).isMinimized()`,
    );
    nativeWindowStates.push({ action: "minimize", minimized });
    if (minimized) break;
    await delay(50);
  }
  writeJson(path.join(artifactDir, "native-minimize-restore.json"), nativeWindowStates);
  assert(nativeWindowStates.at(-1).minimized === true, "Native window never minimized");
  await check("minimized-window");
  await evaluateMain(
    inspectorPort,
    `(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')); win.restore(); })()`,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const minimized = await evaluateMain(
      inspectorPort,
      `process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).isMinimized()`,
    );
    nativeWindowStates.push({ action: "restore", minimized });
    if (!minimized) break;
    await delay(50);
  }
  writeJson(path.join(artifactDir, "native-minimize-restore.json"), nativeWindowStates);
  assert(nativeWindowStates.at(-1).minimized === false, "Native window never restored");
  await check("restored-window");
  const mainPane = deck.getByTestId(`workspace-pane-${initial.layout.focusedPaneId}`);
  await mainPane.getByTestId("workspace-split-pane-menu").click();
  await page.getByTestId("workspace-split-pane-down").click();
  const threePaneLayout = await layoutState();
  const thirdPaneId = threePaneLayout.layout.focusedPaneId;
  await row.getByTestId("workspace-maximize-pane").click();
  await deck.getByRole("button", { name: "Hide browser", exact: true }).click();
  assert(
    await mainPane.isVisible(),
    "Hiding maximized browser failed to restore first of three panes",
  );
  const thirdPane = deck.getByTestId(`workspace-pane-${thirdPaneId}`);
  assert(await thirdPane.isVisible(), "Hiding maximized browser failed to restore third pane");
  await page.screenshot({ path: path.join(artifactDir, "browser-hidden-three-panes.png") });
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  assert(
    (await mainPane.isVisible()) && (await thirdPane.isVisible()),
    "Reveal reused invalid maximization with three panes",
  );
  await thirdPane
    .locator('[data-testid^="workspace-tab-"]')
    .filter({ visible: true })
    .first()
    .hover();
  await thirdPane.getByRole("button", { name: "Close", exact: true }).click();
  await thirdPane.waitFor({ state: "detached" });

  await deck.getByRole("button", { name: "Hide browser", exact: true }).click();
  await callBrowserTool(client, "browser_close_tab", { browserId });
  await composer.fill("");
}

async function waitForBrowserFixture(client, browserId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await client.callTool({
      name: "browser_evaluate",
      args: { browserId, function: "() => Boolean(document.querySelector('#typing-target'))" },
    });
    // Application reload reconnects its automation host after the persisted tabs render.
    if (response.structuredContent?.error?.code !== "browser_no_host") {
      const result = mcpPayload(response, "browser_evaluate");
      if (JSON.parse(result.resultJson)) return;
    }
    await delay(50);
  }
  throw new Error(`Browser fixture ${browserId} never loaded`);
}

async function verifyManualBrowserInsertion({ page, client, serverId, target, artifactDir }) {
  const workspaceKey = `${serverId}:${workspaceIds[0]}`;
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  const deck = page.getByTestId(`workspace-deck-entry-${workspaceKey}`);
  const tabs = [];
  for (const label of ["A", "B", "C"]) {
    tabs.push(
      await callBrowserTool(client, "browser_new_tab", {
        url: `${target.url}?fixture=insertion-${label}`,
      }),
    );
  }
  await revealBrowserForAfter(deck);
  const row = deck.getByRole("tablist", { name: "Browser tabs", exact: true });
  const ids = tabs.map((tab) => `workspace-tab-browser_${tab.browserId}`);
  await row.getByTestId(ids[0]).click();
  const order = () =>
    row
      .getByRole("tab")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
  assert(
    JSON.stringify(await order()) === JSON.stringify(ids),
    "Insertion fixture must start A,B,C",
  );
  const paneId = await row.evaluate((element) =>
    element.closest('[data-testid^="workspace-pane-"]').getAttribute("data-testid"),
  );
  await row.getByRole("button", { name: "New browser tab", exact: true }).click();
  const selected = await row.getByRole("tab", { selected: true }).getAttribute("data-testid");
  const after = await order();
  const expected = [ids[0], selected, ids[1], ids[2]];
  writeJson(path.join(artifactDir, "browser-manual-insertion.json"), {
    before: ids,
    after,
    expected,
    paneId,
    selected,
  });
  assert(selected && !ids.includes(selected), "Plus must select the newly created tab");
  assert(
    JSON.stringify(after) === JSON.stringify(expected),
    "Plus must insert after active A: A,new,B,C",
  );
  assert(
    (await row.evaluate((element) =>
      element.closest('[data-testid^="workspace-pane-"]').getAttribute("data-testid"),
    )) === paneId,
    "Plus changed the destination pane",
  );
  const address = deck
    .getByRole("textbox", { name: "Address", exact: true })
    .filter({ visible: true });
  assert((await address.inputValue()) === "", "Plus must create a blank address");
  assert(
    await address.evaluate((element) => document.activeElement === element),
    "Plus must focus the new address",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-manual-insertion.png") });
  await hideBrowserForAfter(deck);
  for (const id of [...ids, selected])
    await callBrowserTool(client, "browser_close_tab", {
      browserId: id.replace("workspace-tab-browser_", ""),
    });
}

async function verifyUnpresentedBrowserCrash({
  page,
  client,
  target,
  artifactDir,
  inspectorPort,
  evicted,
}) {
  const kind = evicted ? "evicted" : "background";
  const keeper = await callBrowserTool(client, "browser_new_tab", {
    url: `${target.url}?fixture=crash-keeper-${kind}`,
  });
  const tab = await callBrowserTool(client, "browser_new_tab", {
    url: `${target.url}?fixture=crash-${kind}`,
  });
  const siblings = [keeper];
  if (evicted) {
    await revealBrowserForAfter(page);
    await page
      .getByTestId(`workspace-tab-browser_${tab.browserId}`)
      .filter({ visible: true })
      .click();
    for (let index = 0; index < 3; index++) {
      const sibling = await callBrowserTool(client, "browser_new_tab", {
        url: `${target.url}?fixture=crash-sibling-${index}`,
      });
      siblings.push(sibling);
      await page
        .getByTestId(`workspace-tab-browser_${sibling.browserId}`)
        .filter({ visible: true })
        .click();
    }
  }
  await page.getByTestId(`browser-webview-clip-${tab.browserId}`).waitFor({ state: "detached" });
  if (evicted) await hideBrowserForAfter(page);
  await waitForBrowserFixture(client, tab.browserId);
  const before = await readContinuity(page, client, tab.browserId);
  const crashed = await evaluateMain(
    inspectorPort,
    `(async () => {
    const guest = process.mainModule.require('electron').webContents.fromId(${before.webContentsId});
    const gone = new Promise(resolve => guest.once('render-process-gone', (_event, details) => resolve(details)));
    guest.forcefullyCrashRenderer();
    return await gone;
  })()`,
  );
  await revealBrowserForAfter(page);
  await page
    .getByTestId(`workspace-tab-browser_${tab.browserId}`)
    .filter({ visible: true })
    .click();
  const error = page
    .getByText("This page crashed. Reload to try again.", { exact: true })
    .filter({ visible: true });
  await error.waitFor({ state: "visible", timeout: 10_000 });
  const revealed = await readGuest(page, tab.browserId);
  assert(
    revealed.webContentsId === before.webContentsId,
    "Reveal replaced the crashed resident before Retry",
  );
  await page.screenshot({ path: path.join(artifactDir, `browser-crashed-${kind}.png`) });
  await page.getByRole("button", { name: "Retry", exact: true }).filter({ visible: true }).click();
  await error.waitFor({ state: "detached" });
  await waitForBrowserFixture(client, tab.browserId);
  const recovered = await readContinuity(page, client, tab.browserId);
  assert(
    recovered.httpLoadCount === before.httpLoadCount + 1,
    "Retry must reload the crashed guest once",
  );
  writeJson(path.join(artifactDir, `browser-crash-${kind}.json`), {
    before,
    crashed,
    revealed,
    recovered,
  });
  await page.screenshot({ path: path.join(artifactDir, `browser-crash-${kind}-retried.png`) });
  for (const closed of [tab, ...siblings])
    await callBrowserTool(client, "browser_close_tab", { browserId: closed.browserId });
}

async function verifyBrowserCrash({ page, client, target, artifactDir, inspectorPort }) {
  const tab = await callBrowserTool(client, "browser_new_tab", {
    url: `${target.url}?fixture=crash-0`,
  });
  await revealBrowserForAfter(page);
  await page
    .getByTestId(`workspace-tab-browser_${tab.browserId}`)
    .filter({ visible: true })
    .click();
  const before = await readContinuity(page, client, tab.browserId);
  const crashed = await evaluateMain(
    inspectorPort,
    `(async () => {
    const guest = process.mainModule.require('electron').webContents.fromId(${before.webContentsId});
    const gone = new Promise(resolve => guest.once('render-process-gone', (_event, details) => resolve(details)));
    guest.forcefullyCrashRenderer();
    return await gone;
  })()`,
  );
  writeJson(path.join(artifactDir, "browser-crash.json"), { before, crashed });
  const error = page.getByText("This page crashed. Reload to try again.", { exact: true });
  await error.waitFor({ state: "visible", timeout: 10_000 });
  await page.screenshot({ path: path.join(artifactDir, "browser-crashed.png") });
  await page.getByRole("button", { name: "Retry", exact: true }).filter({ visible: true }).click();
  await error.waitFor({ state: "detached" });
  await waitForBrowserFixture(client, tab.browserId);
  const recovered = await readContinuity(page, client, tab.browserId);
  assert(recovered.httpLoadCount > before.httpLoadCount, "Crash Retry did not reload the document");
  writeJson(path.join(artifactDir, "browser-crash.json"), { before, crashed, recovered });
  await page.screenshot({ path: path.join(artifactDir, "browser-crash-retried.png") });
  const refusedPort = await reservePort();
  const retryServer = createServer(target.server.listeners("request")[0]);
  const retryUrl = `http://127.0.0.1:${refusedPort}/?fixture=retry-0`;
  const address = page
    .getByRole("textbox", { name: "Address", exact: true })
    .filter({ visible: true });
  try {
    await address.fill(retryUrl);
    await address.press("Enter");
    const failed = page.getByText(/ERR_CONNECTION_REFUSED/).filter({ visible: true });
    await failed.waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(artifactDir, "browser-navigation-error.png") });
    await new Promise((resolve) => retryServer.listen(refusedPort, "127.0.0.1", resolve));
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .filter({ visible: true })
      .click();
    await failed.waitFor({ state: "detached" });
    await waitForBrowserFixture(client, tab.browserId);
    const retried = await readContinuity(page, client, tab.browserId);
    assert(retried.fixtureId === "retry-0", "Navigation Retry did not load recovered endpoint");
    await evaluateMain(
      inspectorPort,
      `(() => {
      const guest = process.mainModule.require('electron').webContents.fromId(${before.webContentsId});
      globalThis.__task7Abort = { events: [], rejection: null };
      guest.once('did-fail-load', (_event, code, description) => { globalThis.__task7Abort.events.push({ code, description }); });
      guest.loadURL(${JSON.stringify(retryUrl.replace(/\/\?.*$/, "/pending?fixture=aborted-0"))})
        .catch(error => { globalThis.__task7Abort.rejection = String(error); });
    })()`,
    );
    for (let attempt = 0; attempt < 100 && !target.pendingRequests.has("aborted-0"); attempt++)
      await delay(50);
    assert(
      target.pendingRequests.has("aborted-0"),
      "Aborted navigation fixture never received request",
    );
    await evaluateMain(
      inspectorPort,
      `process.mainModule.require('electron').webContents.fromId(${before.webContentsId}).loadURL(${JSON.stringify(retryUrl)})`,
    );
    const aborted = await evaluateMain(inspectorPort, `globalThis.__task7Abort`);
    writeJson(path.join(artifactDir, "browser-navigation-retry.json"), { retried, aborted });
    assert(
      aborted.rejection?.includes("ERR_ABORTED"),
      `Expected native ERR_ABORTED rejection: ${JSON.stringify(aborted)}`,
    );
    assert(
      (await page
        .getByRole("button", { name: "Retry", exact: true })
        .filter({ visible: true })
        .count()) === 0,
      "ERR_ABORTED exposed a crash or navigation error",
    );
  } finally {
    for (const response of target.pendingRequests.values()) response.destroy();
    await closeServer(retryServer);
  }

  await hideBrowserForAfter(page);
  await callBrowserTool(client, "browser_close_tab", { browserId: tab.browserId });
}

async function verifyBrowserCloseReopen({
  page,
  client,
  serverId,
  target,
  artifactDir,
  inspectorPort,
}) {
  const workspaceKey = `${serverId}:${workspaceIds[0]}`;
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  const deck = page.getByTestId(`workspace-deck-entry-${workspaceKey}`);
  const keeper = await callBrowserTool(client, "browser_new_tab", { url: target.url });
  const closed = await callBrowserTool(client, "browser_new_tab", { url: target.url });
  const ready = async (browserId) =>
    page.waitForFunction((id) => {
      const guest = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      try {
        return guest && guest.getWebContentsId() > 0 && !guest.isLoading();
      } catch {
        return false;
      }
    }, browserId);
  await ready(closed.browserId);
  const oldGuest = await readGuest(page, closed.browserId);
  await page.evaluate((id) => {
    window.__task6ClosedGuest = document.querySelector(`[data-paseo-browser-id="${id}"]`);
  }, closed.browserId);
  const lastUrl = `${target.url}?task6=last-background-url`;
  // This guest has never been selected; its pane has not installed navigation listeners.
  await callBrowserTool(client, "browser_evaluate", {
    browserId: closed.browserId,
    function: `() => { location.href = ${JSON.stringify(lastUrl)}; return true; }`,
  });
  await page.waitForFunction(
    ({ id, url }) => {
      const guest = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      try {
        return guest && guest.getURL() === url && !guest.isLoading();
      } catch {
        return false;
      }
    },
    { id: closed.browserId, url: lastUrl },
  );
  await callBrowserTool(client, "browser_resize", {
    browserId: closed.browserId,
    width: 390,
    height: 844,
  });
  const staleUrl = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem("workspace-browser-store")).state.browsersById[id].url,
    closed.browserId,
  );
  assert(
    staleUrl === target.url,
    "Background navigation fixture must leave the record URL stale before first presentation",
  );
  await revealBrowserForAfter(deck);
  const row = deck.getByRole("tablist", { name: "Browser tabs", exact: true });
  await deck.getByTestId(`workspace-tab-browser_${keeper.browserId}`).click();
  await deck.getByTestId(`workspace-tab-browser_${closed.browserId}`).hover();
  await deck.getByTestId(`workspace-browser-close-${closed.browserId}`).click();
  await page.waitForFunction(() => !window.__task6ClosedGuest.isConnected);
  assert(
    await evaluateMain(
      inspectorPort,
      `process.mainModule.require('electron').webContents.fromId(${oldGuest.webContentsId}) == null`,
    ),
    "Closed browser retained native guest WebContents",
  );
  const persisted = await page.evaluate(
    () => JSON.parse(localStorage.getItem("workspace-browser-store")).state,
  );
  assert(
    !("lastClosedByWorkspace" in persisted) && !(closed.browserId in persisted.browsersById),
    "Closed descriptor or browser record persisted",
  );
  await row.getByRole("button", { name: "All tabs", exact: true }).click();
  const reopen = page.getByTestId("workspace-browser-reopen-last-closed").filter({ visible: true });
  assert(await reopen.isEnabled(), "Manual close did not enable browser reopen menu");
  await reopen.click();
  const selectedId = async () =>
    (await row.getByRole("tab", { selected: true }).getAttribute("data-testid")).replace(
      "workspace-tab-browser_",
      "",
    );
  let reopenedId = await selectedId();
  assert(
    reopenedId !== closed.browserId && reopenedId !== keeper.browserId,
    "Reopen reused a closed id",
  );
  await ready(reopenedId);
  const reopenedGuest = await readGuest(page, reopenedId);
  assert(
    reopenedGuest.webContentsId !== oldGuest.webContentsId,
    "Reopen reused a destroyed native guest",
  );
  const restored = await callBrowserTool(client, "browser_evaluate", {
    browserId: reopenedId,
    function: "() => ({ url: location.href, width: innerWidth, height: innerHeight })",
  });
  const restoredState = JSON.parse(restored.resultJson);
  assert(
    restoredState.url === lastUrl && restoredState.width === 390 && restoredState.height === 844,
    `Reopen lost URL/viewport: ${restored.resultJson}`,
  );
  assert(
    await page.evaluate(
      (id) =>
        document.querySelector(`[data-paseo-browser-id="${id}"]`) !== window.__task6ClosedGuest,
      reopenedId,
    ),
    "Reopen reused closed DOM reference",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-task6-reopened.png") });
  await row.getByRole("button", { name: "All tabs", exact: true }).click();
  assert(await reopen.isDisabled(), "Successful reopen did not consume closed descriptor");
  await delay(200);
  await page.screenshot({ path: path.join(artifactDir, "browser-task6-reopen-consumed.png") });
  await page.keyboard.press("Escape");
  const sendGuestKey = async (id, key, modifiers, focus = true) => {
    const guest = await readGuest(page, id);
    await evaluateMain(
      inspectorPort,
      `(() => { const wc = process.mainModule.require('electron').webContents.fromId(${guest.webContentsId}); ${focus ? "wc.focus();" : ""} wc.sendInputEvent(${JSON.stringify({ type: "keyDown", keyCode: key, modifiers })}); wc.sendInputEvent(${JSON.stringify({ type: "keyUp", keyCode: key, modifiers })}); return true; })()`,
    );
  };
  const mod = process.platform === "darwin" ? "meta" : "control";
  const focusField = async (id, iframe = false) => {
    await callBrowserTool(client, "browser_evaluate", {
      browserId: id,
      function: iframe
        ? "async () => { const frame = document.createElement('iframe'); frame.srcdoc = '<input id=iframe-typing>'; document.body.appendChild(frame); await new Promise(resolve => frame.onload = resolve); frame.contentDocument.querySelector('input').focus(); return true; }"
        : "() => { document.querySelector('#typing-target').focus(); return true; }",
    });
  };
  await focusField(reopenedId, true);
  await sendGuestKey(reopenedId, "W", [mod]);
  await deck.getByTestId(`workspace-tab-browser_${reopenedId}`).waitFor({ state: "detached" });
  await deck.getByTestId(`workspace-tab-browser_${keeper.browserId}`).click();
  await focusField(keeper.browserId);
  await sendGuestKey(keeper.browserId, "Y", [mod, "shift"]);
  await page.waitForFunction(
    (old) =>
      [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some(
        (tab) =>
          tab.getAttribute("data-testid")?.startsWith("workspace-tab-browser_") &&
          tab.getAttribute("data-testid") !== `workspace-tab-browser_${old}`,
      ),
    keeper.browserId,
  );
  const fieldReopenedId = await selectedId();
  assert(
    fieldReopenedId !== reopenedId && fieldReopenedId !== keeper.browserId,
    "Configured reopen did not cross the guest field",
  );
  await ready(fieldReopenedId);
  await focusField(fieldReopenedId, true);
  await sendGuestKey(fieldReopenedId, "]", ["alt", "shift"]);
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="workspace-tab-browser_${id}"]`)
        ?.getAttribute("aria-selected") === "true",
    keeper.browserId,
  );
  await focusField(keeper.browserId, true);
  await sendGuestKey(keeper.browserId, "Y", [mod, "shift"]);
  // No descriptor remains: the same binding must be absent from the browser policy.
  await delay(150);
  assert((await selectedId()) === keeper.browserId, "Unavailable reopen intercepted an iframe key");
  await focusField(keeper.browserId);
  await callBrowserTool(client, "browser_evaluate", {
    browserId: keeper.browserId,
    function:
      "() => { window.task6Keys = []; window.task6Composition = []; for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) window.addEventListener(type, event => window.task6Composition.push({ type, data: event.data, trusted: event.isTrusted })); window.addEventListener('keydown', event => window.task6Keys.push({ code: event.code, isComposing: event.isComposing, keyCode: event.keyCode, trusted: event.isTrusted })); return true; }",
  });
  const keeperGuest = await readGuest(page, keeper.browserId);
  const beforeIme = (await callBrowserTool(client, "browser_list_tabs")).tabs.length;
  writeJson(path.join(artifactDir, "browser-task6-before-ime.json"), {
    closedId: closed.browserId,
    oldGuest,
    reopenedId,
    reopenedGuest,
    restoredState,
    staleUrl,
    fieldReopenedId,
    keeperGuest,
  });
  await evaluateMain(
    inspectorPort,
    `process.mainModule.require('electron').webContents.fromId(${keeperGuest.webContentsId}).focus()`,
  );
  await clickGuestElement(page, client, keeper.browserId, "#typing-target");
  assert(
    await waitForGuestActiveElement(client, keeper.browserId, "typing-target"),
    "IME fixture physical click did not focus root input",
  );
  await evaluateMain(
    inspectorPort,
    `process.mainModule.require('electron').webContents.fromId(${keeperGuest.webContentsId}).debugger.sendCommand('Input.imeSetComposition', { text: '仮', selectionStart: 0, selectionEnd: 1 })`,
  );
  const compositionBeforeKey = JSON.parse(
    (
      await callBrowserTool(client, "browser_evaluate", {
        browserId: keeper.browserId,
        function:
          "() => ({ activeId: document.activeElement.id, events: window.task6Composition, inputValue: document.querySelector('#typing-target').value })",
      })
    ).resultJson,
  );
  writeJson(
    path.join(artifactDir, "browser-task6-composition-before-key.json"),
    compositionBeforeKey,
  );
  await sendGuestKey(keeper.browserId, "B", [mod, "shift"], false);
  await delay(150);
  const imeEvents = JSON.parse(
    (
      await callBrowserTool(client, "browser_evaluate", {
        browserId: keeper.browserId,
        function: "() => window.task6Keys",
      })
    ).resultJson,
  );
  const composition = JSON.parse(
    (
      await callBrowserTool(client, "browser_evaluate", {
        browserId: keeper.browserId,
        function:
          "() => ({ events: window.task6Composition, inputValue: document.querySelector('#typing-target').value })",
      })
    ).resultJson,
  );
  writeJson(path.join(artifactDir, "browser-task6-ime-discriminator.json"), {
    imeEvents,
    composition,
    tabs: (await callBrowserTool(client, "browser_list_tabs")).tabs,
  });
  assert(
    imeEvents.some((event) => event.trusted && event.isComposing),
    `No trusted composing key reached guest: ${JSON.stringify(imeEvents)}`,
  );
  assert(
    (await callBrowserTool(client, "browser_list_tabs")).tabs.length === beforeIme,
    "Browser creation shortcut escaped IME composition",
  );
  await evaluateMain(
    inspectorPort,
    `process.mainModule.require('electron').webContents.fromId(${keeperGuest.webContentsId}).debugger.sendCommand('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })`,
  );
  await evaluateMain(
    inspectorPort,
    `process.mainModule.require('electron').webContents.fromId(${keeperGuest.webContentsId}).debugger.sendCommand('Input.dispatchKeyEvent', ${JSON.stringify({ type: "keyDown", key: "B", code: "KeyB", windowsVirtualKeyCode: 229, modifiers: process.platform === "darwin" ? 9 : 3 })})`,
  );
  await delay(150);
  const key229Events = JSON.parse(
    (
      await callBrowserTool(client, "browser_evaluate", {
        browserId: keeper.browserId,
        function: "() => window.task6Keys",
      })
    ).resultJson,
  );
  assert(
    key229Events.some((event) => event.trusted && event.keyCode === 229),
    `No trusted keyCode229 reached guest: ${JSON.stringify(key229Events)}`,
  );
  assert(
    (await callBrowserTool(client, "browser_list_tabs")).tabs.length === beforeIme,
    "Browser creation shortcut escaped keyCode229 containment",
  );
  await focusField(keeper.browserId, true);
  await sendGuestKey(keeper.browserId, "B", [mod, "shift"]);
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some(
        (tab) =>
          tab.getAttribute("data-testid")?.startsWith("workspace-tab-browser_") &&
          tab.getAttribute("data-testid") !== `workspace-tab-browser_${id}`,
      ),
    keeper.browserId,
  );
  const createdId = await selectedId();
  assert(
    createdId !== keeper.browserId && createdId !== fieldReopenedId,
    "Browser creation shortcut failed from iframe",
  );
  const address = page
    .getByRole("textbox", { name: "Address", exact: true })
    .filter({ visible: true });
  await address.press(process.platform === "darwin" ? "Meta+w" : "Control+w");
  await deck.getByTestId(`workspace-tab-browser_${createdId}`).waitFor({ state: "detached" });
  writeJson(path.join(artifactDir, "browser-task6-lifecycle.json"), {
    closedId: closed.browserId,
    oldGuest,
    reopenedId,
    reopenedGuest,
    restoredState,
    fieldReopenedId,
    imeEvents,
    key229Events,
    createdId,
  });
  await hideBrowserForAfter(deck);
  await callBrowserTool(client, "browser_close_tab", { browserId: fieldReopenedId });
  await callBrowserTool(client, "browser_close_tab", { browserId: keeper.browserId });
}

async function verifyBrowserOverflow({ page, client, target, artifactDir, inspectorPort }) {
  const originalBounds = await evaluateMain(
    inspectorPort,
    `process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).getBounds()`,
  );
  const ids = [];
  try {
    await evaluateMain(
      inspectorPort,
      `process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).setSize(1100, 800)`,
    );
    for (let index = 0; index < 10; index++) {
      const tab = await callBrowserTool(client, "browser_new_tab", {
        url: `${target.url}?fixture=overflow-${index}`,
      });
      ids.push(tab.browserId);
      if (index === 0) await revealBrowserForAfter(page);
      if ([0, 4, 9].includes(index)) {
        await page.screenshot({ path: path.join(artifactDir, `browser-${index + 1}-tabs.png`) });
      }
    }
    const selectedId = ids[5];
    const selected = page
      .getByTestId(`workspace-tab-browser_${selectedId}`)
      .filter({ visible: true });
    const row = page
      .getByRole("tablist", { name: "Browser tabs", exact: true })
      .filter({ has: selected });
    const scroller = row.getByTestId("workspace-tabs-scroll");
    assert(
      (await row.getByRole("tab").count()) === 10,
      "Browser row must expose all ten chips as tabs",
    );
    await selected.click();
    await row.getByRole("button", { name: "All tabs", exact: true }).click();
    await page
      .getByTestId("workspace-browser-reopen-last-closed")
      .filter({ visible: true })
      .waitFor({ state: "visible" });
    await delay(200);
    await page.screenshot({ path: path.join(artifactDir, "browser-overflow-menu.png") });
    await page.keyboard.press("Escape");
    const readTabs = () =>
      page.evaluate(() => ({
        rows: [...document.querySelectorAll('[role="tablist"]')].map((tabRow) => ({
          label: tabRow.getAttribute("aria-label"),
          tabs: [...tabRow.querySelectorAll('[role="tab"]')].map((tab) => ({
            id: tab.getAttribute("data-testid"),
            selected: tab.getAttribute("aria-selected"),
            bounds: tab.getBoundingClientRect().toJSON(),
          })),
        })),
        layout: JSON.parse(localStorage.getItem("workspace-layout-state")).state,
      }));
    writeJson(path.join(artifactDir, "overflow-before-removal.json"), await readTabs());
    assert(
      (await selected.getAttribute("aria-selected")) === "true",
      "Sixth browser tab click did not select it",
    );
    await selected.evaluate((el) => {
      const scroll = el
        .closest('[role="tablist"]')
        .querySelector('[data-testid="workspace-tabs-scroll"]');
      scroll.scrollLeft += el.getBoundingClientRect().left - scroll.getBoundingClientRect().left;
    });
    const assertSelectedVisible = async (label) => {
      assert(
        (await row.getByRole("tab", { selected: true }).getAttribute("data-testid")) ===
          `workspace-tab-browser_${selectedId}`,
        `${label} changed selected browser`,
      );
      await page.waitForFunction((id) => {
        const tab = document.querySelector(`[data-testid="workspace-tab-browser_${id}"]`);
        const scroll = tab
          .closest('[role="tablist"]')
          .querySelector('[data-testid="workspace-tabs-scroll"]');
        const a = tab.getBoundingClientRect(),
          b = scroll.getBoundingClientRect();
        return a.left >= b.left - 1 && a.right <= b.right + 1;
      }, selectedId);
    };
    await callBrowserTool(client, "browser_close_tab", { browserId: ids[0] });
    await row.getByTestId(`workspace-tab-browser_${ids[0]}`).waitFor({ state: "detached" });
    writeJson(path.join(artifactDir, "overflow-after-removal.json"), await readTabs());
    await assertSelectedVisible("inactive removal");
    await page.screenshot({ path: path.join(artifactDir, "browser-overflow-removal.png") });
    const order = () =>
      row
        .getByRole("tab")
        .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-testid")));
    for (const direction of [-1, 1]) {
      const before = await order();
      await scroller.evaluate((el, scrollDirection) => {
        el.scrollLeft = scrollDirection < 0 ? 0 : el.scrollWidth;
      }, direction);
      await selected.scrollIntoViewIfNeeded();
      const a = await selected.boundingBox(),
        b = await scroller.boundingBox();
      assert(a && b, "Overflow drag needs visible tab and scroller bounds");
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(direction < 0 ? b.x + 8 : b.x + b.width - 8, a.y + a.height / 2, {
        steps: 15,
      });
      await delay(1200);
      await page.mouse.up();
      await delay(250);
      assert(
        JSON.stringify(await order()) !== JSON.stringify(before),
        "Browser tab drag did not change order",
      );
      await assertSelectedVisible(`reorder ${direction}`);
      await page.screenshot({
        path: path.join(artifactDir, `browser-overflow-reorder-${direction}.png`),
      });
    }
    await scroller.evaluate((el) => {
      el.scrollLeft = 0;
    });
    const scrollBefore = await scroller.evaluate((el) => el.scrollLeft);
    await callBrowserTool(client, "browser_evaluate", {
      browserId: ids[9],
      function: "() => { document.title = 'Updated fixture title'; return true; }",
    });
    await delay(250);
    assert(
      (await scroller.evaluate((el) => el.scrollLeft)) === scrollBefore,
      "Metadata update pulled row back to selection",
    );
    writeJson(path.join(artifactDir, "overflow-result.json"), {
      selectedId,
      order: await order(),
      metadataScrollLeft: scrollBefore,
    });
    await page
      .getByRole("button", { name: "Hide browser", exact: true })
      .filter({ visible: true })
      .click();
  } catch (error) {
    await page.screenshot({ path: path.join(artifactDir, "browser-overflow-failure.png") });
    throw error;
  } finally {
    for (const browserId of ids.slice(1))
      await callBrowserTool(client, "browser_close_tab", { browserId });
    await evaluateMain(
      inspectorPort,
      `process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).setBounds(${JSON.stringify(originalBounds)})`,
    );
  }
}

async function verifyBrowserLastOrdinary({ page, serverId, artifactDir }) {
  const workspaceKey = `${serverId}:${workspaceIds[1]}`;
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  const deck = page.getByTestId(`workspace-deck-entry-${workspaceKey}`);
  const originalPaneId = await page.evaluate(
    (key) =>
      JSON.parse(localStorage.getItem("workspace-layout-state")).state.layoutByWorkspace[key]
        .focusedPaneId,
    workspaceKey,
  );
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  const originalPane = deck.getByTestId(`workspace-pane-${originalPaneId}`);
  await originalPane
    .locator('[data-testid^="workspace-tab-"]')
    .filter({ visible: true })
    .first()
    .hover();
  await originalPane.getByRole("button", { name: "Close", exact: true }).click();
  await originalPane.waitFor({ state: "detached" });
  await deck.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
  const hide = deck.getByRole("button", { name: "Hide browser", exact: true });
  assert(await hide.isDisabled(), "Explorer must not allow hiding the final ordinary browser pane");
  assert(
    await deck.getByRole("tablist", { name: "Browser tabs", exact: true }).isVisible(),
    "Final ordinary browser disappeared",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-last-ordinary-explorer.png") });
  const row = deck.getByRole("tablist", { name: "Browser tabs", exact: true });
  await row.getByRole("button", { name: "All tabs", exact: true }).click();
  const reopen = page.getByTestId("workspace-browser-reopen-last-closed").filter({ visible: true });
  assert(await reopen.isDisabled(), "Empty launcher without descriptor must disable reopen");
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "New browser tab", exact: true }).click();
  const tabId = await row.getByRole("tab", { selected: true }).getAttribute("data-testid");
  await page
    .getByRole("textbox", { name: "Address", exact: true })
    .filter({ visible: true })
    .press(process.platform === "darwin" ? "Meta+w" : "Control+w");
  await deck.getByTestId(tabId).waitFor({ state: "detached" });
  assert(await row.isVisible(), "Closing the last browser removed its ordinary launcher");
  await row.getByRole("button", { name: "All tabs", exact: true }).click();
  assert(await reopen.isEnabled(), "Retained launcher cannot reopen its manually closed page");
  await delay(200);
  await page.screenshot({ path: path.join(artifactDir, "browser-task6-last-launcher-menu.png") });
  await reopen.click();
  assert(
    (await row.getByRole("tab", { selected: true }).getAttribute("data-testid")) !== tabId,
    "Launcher reopen reused a closed browser id",
  );
  await page
    .getByRole("textbox", { name: "Address", exact: true })
    .filter({ visible: true })
    .click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+w" : "Control+w");
  await deck.getByRole("button", { name: "Close Explorer sidebar", exact: true }).click();
  await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[0]}`).click();
}

async function verifyBrowserPlacementError({ page, client, serverId, typingAgent, artifactDir }) {
  const workspaceKey = `${serverId}:${typingAgent.workspaceId}`;
  const deck = page.getByTestId(`workspace-deck-entry-${workspaceKey}`);
  const readLayout = () =>
    page.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem("workspace-layout-state")).state.layoutByWorkspace[key],
      workspaceKey,
    );
  const runCommand = async (label) => {
    await page.getByTestId("sidebar-search").click();
    await page.getByTestId("command-center-input").fill(label);
    await page.getByText(label, { exact: true }).click();
  };
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  await deck.getByTestId(`workspace-tab-agent_${typingAgent.agentId}`).click();
  const newPaneIds = [];
  for (const direction of ["down", "right", "down"]) {
    await runCommand(`Split pane ${direction}`);
    newPaneIds.push((await readLayout()).focusedPaneId);
  }
  await deck.getByTestId(`workspace-tab-agent_${typingAgent.agentId}`).click();
  const alert = deck.getByTestId("workspace-browser-open-error");
  const recordsBefore = await callBrowserTool(client, "browser_list_tabs");
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  await alert.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(artifactDir, "browser-show-placement-error.png") });
  const deepestPane = deck.getByTestId(`workspace-pane-${newPaneIds.pop()}`);
  await deepestPane
    .locator('[data-testid^="workspace-tab-"]')
    .filter({ visible: true })
    .first()
    .hover();
  await deepestPane.getByRole("button", { name: "Close", exact: true }).click();
  await deepestPane.waitFor({ state: "detached" });
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  await alert.waitFor({ state: "detached" });
  const blankRow = deck.getByRole("tablist", { name: "Browser tabs", exact: true });
  assert(await blankRow.isVisible(), "Show Retry did not reveal its blank browser pane");
  assert(
    JSON.stringify((await callBrowserTool(client, "browser_list_tabs")).tabs) ===
      JSON.stringify(recordsBefore.tabs),
    "Show Retry created a BrowserRecord",
  );
  await blankRow.getByRole("tab", { selected: true }).hover();
  await blankRow.getByRole("button", { name: "Close", exact: true }).click();
  await blankRow.waitFor({ state: "detached" });
  const previousDeepest = deck.getByTestId(`workspace-pane-${newPaneIds.at(-1)}`);
  await previousDeepest
    .locator('[data-testid^="workspace-tab-"]')
    .filter({ visible: true })
    .first()
    .click();
  await runCommand("Split pane down");
  newPaneIds.push((await readLayout()).focusedPaneId);
  await deck.getByTestId(`workspace-tab-agent_${typingAgent.agentId}`).click();
  const before = await readLayout();
  await runCommand("New browser");
  await alert.waitFor({ state: "visible" });
  assert(
    (await alert.innerText()).includes(
      "Couldn't open the browser in this layout. Close a pane and retry.",
    ),
    "Placement failure must expose recovery copy",
  );
  assert(
    JSON.stringify(await readLayout()) === JSON.stringify(before),
    "Failed placement changed the layout",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-placement-error.png") });
  await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[0]}`).click();
  assert(
    (await page.getByTestId("workspace-browser-open-error").filter({ visible: true }).count()) ===
      0,
    "Placement error leaked to another workspace",
  );
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  await alert.getByRole("button", { name: "Dismiss", exact: true }).click();
  await alert.waitFor({ state: "detached" });
  assert(
    JSON.stringify(await readLayout()) === JSON.stringify(before),
    "Dismiss changed the layout",
  );
  await runCommand("New browser");
  await alert.waitFor({ state: "visible" });
  const lastPane = deck.getByTestId(`workspace-pane-${newPaneIds.at(-1)}`);
  await lastPane
    .locator('[data-testid^="workspace-tab-"]')
    .filter({ visible: true })
    .first()
    .hover();
  await lastPane.getByRole("button", { name: "Close", exact: true }).click();
  await lastPane.waitFor({ state: "detached" });
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  await alert.waitFor({ state: "detached" });
  const row = deck
    .getByRole("tablist", { name: "Browser tabs", exact: true })
    .filter({ visible: true });
  assert(
    (await row.getByRole("tab", { selected: true }).count()) === 1,
    "Retry did not create/select the requested browser",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-placement-retried.png") });
  await row.getByRole("tab", { selected: true }).hover();
  await row.getByRole("button", { name: "Close", exact: true }).click();
  await row.waitFor({ state: "detached" });
  for (const paneId of newPaneIds.slice(0, -1).toReversed()) {
    const pane = deck.getByTestId(`workspace-pane-${paneId}`);
    await pane.locator('[data-testid^="workspace-tab-"]').filter({ visible: true }).first().hover();
    await pane.getByRole("button", { name: "Close", exact: true }).click();
    await pane.waitFor({ state: "detached" });
  }
  await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[0]}`).click();
}

async function verifyReloadedBrowser({ page, client, browserId, artifactDir, label }) {
  await page.waitForFunction((id) => {
    const guest = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    try {
      return (
        guest &&
        guest.getWebContentsId() > 0 &&
        guest.getURL().includes("fixture=final-0") &&
        !guest.isLoading()
      );
    } catch {
      return false;
    }
  }, browserId);
  const native = await page.evaluate(async (id) => {
    const guest = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    return {
      webContentsId: guest.getWebContentsId(),
      url: guest.getURL(),
      fixture: await guest.executeJavaScript(
        "({ fixtureId, inputPresent: !!document.querySelector('#typing-target') })",
      ),
    };
  }, browserId);
  assert(
    native.fixture.inputPresent && native.fixture.fixtureId === "final-0",
    `${label} native page did not restore`,
  );
  const response = await client.callTool({
    name: "browser_evaluate",
    args: { browserId, function: "() => fixtureId" },
  });
  const direct = response.structuredContent;
  writeJson(path.join(artifactDir, `${label}-direct.json`), { native, direct });
  const result = mcpPayload(response, "browser_evaluate");
  assert(JSON.parse(result.resultJson) === "final-0", `${label} direct evaluation lost fixture`);
  const afterDirect = await readContinuity(page, client, browserId);
  writeJson(path.join(artifactDir, `${label}-direct.json`), { native, direct, afterDirect });
  return afterDirect;
}

async function verifyBrowserFinalLifecycle({
  page,
  client,
  serverId,
  callerAgentId,
  target,
  artifactDir,
  inspectorPort,
}) {
  const workspaceKey = `${serverId}:${workspaceIds[0]}`;
  const deck = page.getByTestId(`workspace-deck-entry-${workspaceKey}`);
  const panes = (node) => (node.kind === "pane" ? [node.pane] : node.group.children.flatMap(panes));
  const readState = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("workspace-layout-state")).state);
  const command = async (label) => {
    await page.getByTestId("sidebar-search").click();
    await page.getByTestId("command-center-input").fill(label);
    await page.getByText(label, { exact: true }).click();
  };
  const drag = async (from, to) => {
    await from.scrollIntoViewIfNeeded();
    const a = await from.boundingBox(),
      b = await to.boundingBox();
    assert(a && b, "Cross-pane drag needs visible bounds");
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
    await delay(400);
    await page.mouse.up();
    await delay(250);
  };
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  const tab = await callBrowserTool(client, "browser_new_tab", {
    url: `${target.url}?fixture=final-0`,
  });
  const duplicate = await callBrowserTool(client, "browser_new_tab", {
    url: `${target.url}?fixture=final-0`,
  });
  assert(tab.browserId !== duplicate.browserId, "Duplicate URL reused browser identity");
  const originalGuest = await readGuest(page, tab.browserId);
  const duplicateGuest = await readGuest(page, duplicate.browserId);
  assert(
    originalGuest.webContentsId !== duplicateGuest.webContentsId,
    "Duplicate URL reused native guest",
  );
  const showBrowser = deck.getByRole("button", { name: "Show browser", exact: true });
  if (await showBrowser.isVisible()) await showBrowser.click();
  await deck
    .getByRole("tablist", { name: "Browser tabs", exact: true })
    .waitFor({ state: "visible" });
  await deck.getByTestId(`workspace-tab-agent_${callerAgentId}`).click();
  const terminalIdsBefore = panes((await readState()).layoutByWorkspace[workspaceKey].root)
    .flatMap((pane) => pane.tabs ?? [])
    .filter((item) => item.target.kind === "terminal")
    .map((item) => item.tabId);
  await command("New terminal");
  await page.waitForFunction(
    ({ key, known }) => {
      const layout = JSON.parse(localStorage.getItem("workspace-layout-state")).state
        .layoutByWorkspace[key];
      const collect = (node) =>
        node.kind === "pane" ? (node.pane.tabs ?? []) : node.group.children.flatMap(collect);
      return collect(layout.root).some(
        (item) => item.target.kind === "terminal" && !known.includes(item.tabId),
      );
    },
    { key: workspaceKey, known: terminalIdsBefore },
  );
  const before = await readState();
  const workspacePanes = panes(before.layoutByWorkspace[workspaceKey].root);
  const agentPane = workspacePanes.find((pane) => pane.tabIds.includes(`agent_${callerAgentId}`));
  const terminal = workspacePanes
    .flatMap((pane) => pane.tabs ?? [])
    .find((item) => item.target.kind === "terminal" && !terminalIdsBefore.includes(item.tabId));
  assert(terminal, "New terminal did not create a workspace tab");
  const browserPaneId = before.browserPaneIdByWorkspace[workspaceKey];
  const browserPane = deck.getByTestId(`workspace-pane-${browserPaneId}`);
  await drag(deck.getByTestId(`workspace-tab-${terminal.tabId}`), browserPane.getByRole("tablist"));
  const mixed = await readState();
  const mixedPane = panes(mixed.layoutByWorkspace[workspaceKey].root).find(
    (pane) => pane.id === browserPaneId,
  );
  assert(
    mixedPane.tabIds.includes(terminal.tabId) &&
      mixedPane.tabIds.includes(`browser_${tab.browserId}`),
    "Terminal drag did not create a mixed browser pane",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-mixed-pane.png") });
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  await deck.getByRole("button", { name: "Hide browser", exact: true }).click();
  assert(await browserPane.isVisible(), "Browser toggle hid a mixed pane");
  await drag(
    browserPane.getByTestId(`workspace-tab-browser_${tab.browserId}`),
    deck.getByTestId(`workspace-tab-agent_${callerAgentId}`),
  );
  await deck.getByRole("button", { name: "Show browser", exact: true }).click();
  await deck.getByRole("button", { name: "Hide browser", exact: true }).click();
  const moved = await readState();
  assert(
    panes(moved.layoutByWorkspace[workspaceKey].root)
      .find((pane) => pane.id === agentPane.id)
      .tabIds.includes(`browser_${tab.browserId}`),
    "Toggle moved a manually placed browser",
  );
  const terminals = (await client.callTool({ name: "list_terminals", args: {} })).structuredContent;
  const agent = (
    await client.callTool({ name: "get_agent_status", args: { agentId: callerAgentId } })
  ).structuredContent;
  assert(
    terminals.terminals.some((item) => item.id === terminal.target.terminalId),
    "Browser toggle closed terminal",
  );
  writeJson(path.join(artifactDir, "browser-toggle-resources.json"), { terminals, agent });
  assert(agent.snapshot.archivedAt == null, "Browser toggle archived agent");
  assert(
    (await readGuest(page, tab.browserId)).webContentsId === originalGuest.webContentsId,
    "Manual move recreated browser guest",
  );
  await page.screenshot({ path: path.join(artifactDir, "browser-manually-moved.png") });
  await page.reload();
  await waitForDesktopStatus(page);
  await deck.getByTestId(`workspace-tab-browser_${tab.browserId}`).waitFor({ state: "visible" });
  const reloaded = await readState();
  assert(
    panes(reloaded.layoutByWorkspace[workspaceKey].root)
      .find((pane) => pane.id === agentPane.id)
      .tabIds.includes(`browser_${tab.browserId}`),
    "Application reload lost manual placement",
  );
  await deck.getByTestId(`workspace-tab-browser_${tab.browserId}`).click();
  const reloadGuest = await verifyReloadedBrowser({
    page,
    client,
    browserId: tab.browserId,
    artifactDir,
    label: "application-reload",
  });
  assert(reloadGuest.fixtureId === "final-0", "Application reload lost browser URL");
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("workspace-layout-state"));
    delete saved.state.browserPaneIdByWorkspace;
    const oldPane = (node) => {
      if (node.kind === "pane") delete node.pane.hidden;
      else node.group.children.forEach(oldPane);
    };
    Object.values(saved.state.layoutByWorkspace).forEach((layout) => oldPane(layout.root));
    localStorage.setItem("workspace-layout-state", JSON.stringify(saved));
  });
  await page.reload();
  await waitForDesktopStatus(page);
  await deck.getByTestId(`workspace-tab-browser_${tab.browserId}`).waitFor({ state: "visible" });
  const legacy = await readState();
  assert(
    panes(legacy.layoutByWorkspace[workspaceKey].root).some((pane) =>
      pane.tabIds.includes(`browser_${tab.browserId}`),
    ),
    "Legacy layout restore lost browser",
  );
  await deck.getByTestId(`workspace-tab-browser_${tab.browserId}`).click();
  await verifyReloadedBrowser({
    page,
    client,
    browserId: tab.browserId,
    artifactDir,
    label: "legacy-layout",
  });
  await page.screenshot({ path: path.join(artifactDir, "browser-legacy-layout.png") });
  const purgeKey = `${serverId}:${workspaceIds[1]}`;
  await page.getByTestId(`sidebar-workspace-row-${purgeKey}`).click();
  await command("New browser");
  const purgeDeck = page.getByTestId(`workspace-deck-entry-${purgeKey}`);
  const address = purgeDeck
    .getByRole("textbox", { name: "Address", exact: true })
    .filter({ visible: true });
  await address.fill(`${target.url}?fixture=purge-0`);
  await address.press("Enter");
  const purgeBefore = await readState();
  const purgeTabs = panes(purgeBefore.layoutByWorkspace[purgeKey].root)
    .flatMap((pane) => pane.tabs ?? [])
    .filter((item) => item.target.kind === "browser");
  const purgeGuests = [];
  for (const item of purgeTabs)
    purgeGuests.push({
      browserId: item.target.browserId,
      ...(await readGuest(page, item.target.browserId)),
    });
  assert(purgeGuests.length > 0, "Purge fixture has no browser guest");
  await page.getByTestId(`sidebar-workspace-row-${purgeKey}`).hover();
  await page.getByTestId(`sidebar-workspace-archive-${purgeKey}`).click();
  await page.waitForFunction(
    (key) =>
      !JSON.parse(localStorage.getItem("workspace-layout-state")).state.layoutByWorkspace[key],
    purgeKey,
  );
  const purgeNative = await readRendererMemory(inspectorPort, purgeGuests);
  assert(
    purgeNative.guests.every((guest) => !guest.webContentsAlive),
    "Workspace purge retained native guests",
  );
  const purgedRecords = await page.evaluate(
    () => JSON.parse(localStorage.getItem("workspace-browser-store")).state.browsersById,
  );
  assert(
    purgeGuests.every((guest) => !purgedRecords[guest.browserId]),
    "Workspace purge retained browser records",
  );
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).click();
  assert(
    (await callBrowserTool(client, "browser_list_tabs")).tabs.some(
      (item) => item.browserId === tab.browserId,
    ),
    "Purge removed other workspace browser",
  );
  writeJson(path.join(artifactDir, "browser-final-lifecycle.json"), {
    originalGuest,
    duplicateGuest,
    before,
    mixed,
    moved,
    terminals,
    agent,
    reloaded,
    reloadGuest,
    legacy,
    purgeGuests,
    purgeNative,
  });
}

async function readRendererMemory(inspectorPort, cohort) {
  return await evaluateMain(
    inspectorPort,
    `(() => {
    const { app, webContents, BrowserWindow } = process.mainModule.require('electron');
    const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).webContents;
    const guests = ${JSON.stringify(cohort)}.map(tab => {
      const guest = webContents.fromId(tab.webContentsId);
      const webContentsAlive = Boolean(guest && !guest.isDestroyed());
      const pid = webContentsAlive ? guest.getOSProcessId() : null;
      return { ...tab, originalPid: tab.originalPid ?? pid, webContentsAlive, pid };
    });
    const rawMetrics = app.getAppMetrics();
    const guestPids = [...new Set(guests.map(tab => tab.pid).filter(Boolean))];
    const cohortPids = [...new Set(guests.map(tab => tab.originalPid).filter(Boolean))];
    const cohortRendererMetrics = rawMetrics.filter(metric => cohortPids.includes(metric.pid));
    const liveGuestRendererMetrics = rawMetrics.filter(metric => guestPids.includes(metric.pid));
    const pidAttribution = cohortPids.map(pid => ({ pid,
      browserIds: guests.filter(tab => tab.originalPid === pid).map(tab => tab.browserId),
      liveBrowserIds: guests.filter(tab => tab.pid === pid).map(tab => tab.browserId),
      sharedWithHost: pid === host.getOSProcessId(),
      processStillPresent: rawMetrics.some(metric => metric.pid === pid) }));
    return { capturedAt: new Date().toISOString(), guests, guestPids, cohortPids, pidAttribution,
      host: { webContentsId: host.id, pid: host.getOSProcessId() },
      hostRendererMetric: rawMetrics.find(metric => metric.pid === host.getOSProcessId()), cohortRendererMetrics, liveGuestRendererMetrics,
      cohortWorkingSetSizeKiB: cohortRendererMetrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
      liveGuestWorkingSetSizeKiB: liveGuestRendererMetrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
      rawMetrics, memoryUnit: 'KiB', versions: process.versions };
  })()`,
  );
}

async function measureTabSwitch(page, browserId, sampleId) {
  const tabLocator = page
    .getByTestId(`workspace-tab-browser_${browserId}`)
    .filter({ visible: true })
    .first();
  // Visibility and scrolling happen before the timed pointer event, outside the latency interval.
  await tabLocator.scrollIntoViewIfNeeded();
  const bounds = await tabLocator.boundingBox();
  assert(bounds, "Measured browser tab has no clickable bounds");
  await page.evaluate(
    ({ browserId: id, sampleId: markerId }) => {
      const tab = [
        ...document.querySelectorAll(`[data-testid="workspace-tab-browser_${id}"]`),
      ].find((element) => element.getBoundingClientRect().width > 0);
      const surface = document.querySelector(`[data-paseo-browser-surface="${id}"]`);
      if (!tab || !surface) throw new Error("Missing measured tab or guest surface");
      const sample = {
        browserId: id,
        sampleId: markerId,
        timeOrigin: performance.timeOrigin,
        click: null,
        selectionApplied: null,
        presentationRequested: null,
      };
      globalThis.__paseoTabSample = sample;
      const mark = (name) => {
        performance.mark(`${markerId}:${name}`);
        console.timeStamp(`${markerId}:${name}`);
      };
      const observer = new MutationObserver(() => {
        if (sample.click === null) return;
        if (sample.selectionApplied === null && tab.getAttribute("aria-selected") === "true") {
          sample.selectionApplied = performance.now();
          mark("selection-applied");
        }
        if (
          sample.presentationRequested === null &&
          surface.getAttribute("aria-hidden") === "false" &&
          surface.style.pointerEvents === "auto"
        ) {
          sample.presentationRequested = performance.now();
          mark("presentation-requested");
        }
        if (sample.selectionApplied !== null && sample.presentationRequested !== null)
          observer.disconnect();
      });
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      tab.addEventListener(
        "pointerdown",
        () => {
          sample.click = performance.now();
          mark("click");
        },
        { once: true, capture: true },
      );
    },
    { browserId, sampleId },
  );
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.waitForFunction(
    () =>
      globalThis.__paseoTabSample?.selectionApplied !== null &&
      globalThis.__paseoTabSample?.presentationRequested !== null,
    null,
    { timeout: timeoutMs },
  );
  return await page.evaluate(() => {
    const sample = globalThis.__paseoTabSample;
    return {
      ...sample,
      selectionAppliedMs: sample.selectionApplied - sample.click,
      presentationRequestedMs: sample.presentationRequested - sample.click,
    };
  });
}

async function hideBrowserForAfter(page) {
  if (phase === "after")
    await page
      .getByRole("button", { name: "Hide browser", exact: true })
      .filter({ visible: true })
      .click();
}

async function revealBrowserForAfter(page) {
  if (phase === "after")
    await page
      .getByRole("button", { name: "Show browser", exact: true })
      .filter({ visible: true })
      .click();
}

async function measureBrowserReopenCycles({ page, client, target, inspectorPort, survivor }) {
  const cycles = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const reopened = [];
    for (let index = 1; index < 10; index++) {
      const tab = await callBrowserTool(client, "browser_new_tab", {
        url: `${target.url}?fixture=cycle-${cycle}-${index}`,
      });
      await waitForBrowserFixture(client, tab.browserId);
      reopened.push({ browserId: tab.browserId, ...(await readGuest(page, tab.browserId)) });
    }
    await delay(10_000);
    const opened = await readRendererMemory(inspectorPort, [survivor, ...reopened]);
    for (const tab of reopened)
      await callBrowserTool(client, "browser_close_tab", { browserId: tab.browserId });
    await delay(10_000);
    const closed = await readRendererMemory(inspectorPort, opened.guests);
    assert(
      closed.guests.filter((tab) => tab.webContentsAlive).length === 1 &&
        closed.guests.slice(1).every((tab) => !tab.webContentsAlive),
      `Reopen cycle ${cycle} retained a closed guest`,
    );
    cycles.push({ cycle, opened, closed });
  }
  return cycles;
}

async function runTabBaseline({ page, client, serverId, target, artifactDir, inspectorPort }) {
  await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[0]}`).click();
  const reportPath = path.join(artifactDir, `browser-tabs-${phase}.json`);
  const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(artifactDir, "measurement-source.patch"),
    execFileSync("git", ["diff", "HEAD", "--", "packages/desktop/e2e/browser-tabs.e2e.mjs"], {
      cwd: rootDir,
      encoding: "utf8",
    }),
  );
  const sourceManifestPath = path.join(
    rootDir,
    ".superpowers/sdd/2026-10-12-browser-tabs/source-state.json",
  );
  const report = {
    phase,
    startedAt: new Date().toISOString(),
    buildMode: "development: Expo Metro + tsc desktop main + tsx daemon",
    source: {
      head: git("rev-parse", "HEAD"),
      status: git("status", "--short"),
      instrumentationPatch: "measurement-source.patch",
      manifest: fs.existsSync(sourceManifestPath)
        ? JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"))
        : null,
    },
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    measurementLabels: {
      selection: "selection applied",
      page: "presentation requested",
      pixelsPresented: false,
      reason:
        "Renderer DOM mutations do not prove presented pixels; Chromium compositor frames are preserved without claiming guest attribution.",
    },
    samples: [],
    memory: {},
    cohort: [],
  };
  writeJson(reportPath, report);
  const cohort = report.cohort;
  const tracePath = path.join(artifactDir, "browser-tabs-chromium-trace.json");
  const cdp = await page.context().newCDPSession(page);
  const framesDir = path.join(artifactDir, "tab-switch-video-frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const videoFrames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = `frame-${String(videoFrames.length).padStart(5, "0")}.jpg`;
    fs.writeFileSync(path.join(framesDir, file), Buffer.from(data, "base64"));
    videoFrames.push({ file, ...metadata });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  let tracing = false;
  try {
    const counterUrl = `${target.url}?fixture=counter-self-check`;
    const counterTab = await callBrowserTool(client, "browser_new_tab", { url: counterUrl });
    const initial = await readContinuity(page, client, counterTab.browserId);
    await page.evaluate(
      (id) => document.querySelector(`[data-paseo-browser-id="${id}"]`).reload(),
      counterTab.browserId,
    );
    await page.waitForFunction(
      async ({ id, previousCount }) => {
        const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
        if (webview.isLoading()) return false;
        return await webview.executeJavaScript(`window.loadCount > ${previousCount}`);
      },
      { id: counterTab.browserId, previousCount: initial.loadCount },
    );
    const reloaded = await readContinuity(page, client, counterTab.browserId);
    assert(
      reloaded.loadCount === initial.loadCount + 1 &&
        reloaded.httpLoadCount === initial.httpLoadCount + 1,
      "Fixture counters did not detect a reload",
    );
    await callBrowserTool(client, "browser_close_tab", { browserId: counterTab.browserId });
    const replacement = await callBrowserTool(client, "browser_new_tab", { url: counterUrl });
    const recreated = await readContinuity(page, client, replacement.browserId);
    assert(
      recreated.webContentsId !== reloaded.webContentsId &&
        recreated.httpLoadCount === reloaded.httpLoadCount + 1,
      "HTTP fixture counter did not detect a new guest",
    );
    await callBrowserTool(client, "browser_close_tab", { browserId: replacement.browserId });
    report.counterSelfCheck = { initial, reloaded, recreated };
    await delay(10_000);
    report.memory.idle = await readRendererMemory(inspectorPort, cohort);
    for (let index = 0; index < 10; index++) {
      const fixtureId = `measurement-${index}`;
      const created = await callBrowserTool(client, "browser_new_tab", {
        url: `${target.url}?fixture=${fixtureId}`,
      });
      await callBrowserTool(client, "browser_evaluate", {
        browserId: created.browserId,
        function: "() => document.readyState",
      });
      const guest = await readGuest(page, created.browserId);
      assert(guest, "Measurement guest has no original WebContents identity");
      cohort.push({ browserId: created.browserId, fixtureId, webContentsId: guest.webContentsId });
      if (index === 1) {
        await revealBrowserForAfter(page);
        const beforeStates = [];
        for (const [tabIndex, tab] of cohort.entries()) {
          await page
            .getByTestId(`workspace-tab-browser_${tab.browserId}`)
            .filter({ visible: true })
            .first()
            .click();
          await callBrowserTool(client, "browser_evaluate", {
            browserId: tab.browserId,
            function: `() => { document.querySelector('#typing-target').value = 'brouillon conservé'; scrollTo(0, ${640 + tabIndex * 180}); return true; }`,
          });
          await delay(100);
          const before = await readContinuity(page, client, tab.browserId);
          assert(
            before.scrollY === 640 + tabIndex * 180,
            "Continuity fixture did not scroll to its known position",
          );
          beforeStates.push(before);
        }
        await page
          .getByTestId(`workspace-tab-browser_${cohort[0].browserId}`)
          .filter({ visible: true })
          .first()
          .click();
        for (let switchIndex = 0; switchIndex < 30; switchIndex++) {
          await measureTabSwitch(
            page,
            cohort[(switchIndex + 1) % 2].browserId,
            `continuity-${switchIndex}`,
          );
        }
        report.continuity = { tabs: [], switches: 30 };
        for (const [tabIndex, tab] of cohort.entries()) {
          const before = beforeStates[tabIndex];
          const after = await readContinuity(page, client, tab.browserId);
          assert(after.webContentsId === before.webContentsId, "Tab switch recreated the guest");
          assert(after.inputValue === "brouillon conservé", "Tab switch lost the draft");
          assert(after.scrollY === before.scrollY, "Tab switch lost scroll position");
          assert(after.loadCount === before.loadCount, "Tab switch reloaded the page");
          assert(
            target.httpLoadCounts.get(tab.fixtureId) === before.httpLoadCount,
            "Tab switch created another HTTP document guest",
          );
          report.continuity.tabs.push({ browserId: tab.browserId, before, after });
        }
        await evaluateMain(
          inspectorPort,
          `process.mainModule.require('electron').contentTracing.startRecording({ included_categories: ['blink.user_timing', 'devtools.timeline', 'cc', 'viz', 'disabled-by-default-devtools.timeline.frame'] })`,
        );
        tracing = true;
      }
      if (index === 1 || index === 9) {
        const count = index + 1;
        // Start each series on tab 0 so every following click changes selection.
        await page
          .getByTestId(`workspace-tab-browser_${cohort[0].browserId}`)
          .filter({ visible: true })
          .first()
          .click();
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 70,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 3,
        });
        for (let switchIndex = 0; switchIndex < 35; switchIndex++) {
          const sample = await measureTabSwitch(
            page,
            cohort[(switchIndex + 1) % count].browserId,
            `tabs-${count}-${switchIndex}`,
          );
          report.samples.push({ tabCount: count, warmup: switchIndex < 5, ...sample });
          // Give the illustrative screencast time to sample both pages; this gap is outside timing.
          await delay(100);
        }
        await cdp.send("Page.stopScreencast");
        writeJson(reportPath, report);
      }
    }
    await evaluateMain(
      inspectorPort,
      `process.mainModule.require('electron').contentTracing.stopRecording(${JSON.stringify(tracePath)})`,
    );
    tracing = false;
    const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
    report.trace = {
      file: path.basename(tracePath),
      rendererMarkers: trace.traceEvents.filter(
        (event) =>
          event.name?.startsWith("tabs-") || event.args?.data?.message?.startsWith("tabs-"),
      ),
      compositorEventCount: trace.traceEvents.filter((event) =>
        /drawframe|submitcompositorframe|presentation|swapbuffers/i.test(event.name),
      ).length,
    };
    assert(
      report.trace.rendererMarkers.length >= 70,
      "Trace did not include renderer timing markers",
    );
    await delay(10_000);
    report.memory.tenPages = await readRendererMemory(inspectorPort, cohort);
    assert(
      report.memory.tenPages.guests.every((tab) => tab.pid),
      "Memory cohort has a missing guest PID",
    );
    cohort.forEach((tab, index) => {
      tab.originalPid = report.memory.tenPages.guests[index].originalPid;
    });
    for (const tab of cohort.slice(1))
      await callBrowserTool(client, "browser_close_tab", { browserId: tab.browserId });
    await delay(10_000);
    report.memory.afterClosingNine = await readRendererMemory(inspectorPort, cohort);
    assert(
      report.memory.afterClosingNine.guests.filter((tab) => tab.webContentsAlive).length === 1 &&
        report.memory.afterClosingNine.guests.slice(1).every((tab) => !tab.webContentsAlive),
      "Closed cohort WebContents remained registered",
    );
    assert(
      report.memory.afterClosingNine.guests.every(
        (tab, index) =>
          tab.webContentsId === report.memory.tenPages.guests[index].webContentsId &&
          tab.originalPid === report.memory.tenPages.guests[index].originalPid,
      ),
      "After-close memory lost original cohort identities",
    );
    assert(
      report.memory.afterClosingNine.cohortPids.length ===
        report.memory.tenPages.guestPids.length &&
        report.memory.afterClosingNine.pidAttribution.flatMap((group) => group.browserIds)
          .length === 10,
      "After-close memory lost historical or shared-PID attribution",
    );
    report.memory.reopenCycles = await measureBrowserReopenCycles({
      page,
      client,
      target,
      inspectorPort,
      survivor: cohort[0],
    });
    const listed = await callBrowserTool(client, "browser_list_tabs");
    assert(
      cohort.slice(1).every((tab) => !listed.tabs.some((live) => live.browserId === tab.browserId)),
      "Closed measurement tabs remained listed",
    );
    for (const count of [2, 10])
      assert(
        report.samples.filter((sample) => sample.tabCount === count && !sample.warmup).length ===
          30,
        "Incomplete measured switch series",
      );
    const compositorEvents = trace.traceEvents.filter((event) =>
      /drawframe|submitcompositorframe|presentation|swapbuffers/i.test(event.name),
    );
    report.trace.correlations = report.samples.map((sample) => {
      const marker = report.trace.rendererMarkers.find(
        (event) => event.name === `${sample.sampleId}:click`,
      );
      assert(marker, `Missing Chromium click marker for ${sample.sampleId}`);
      const guest = report.memory.tenPages.guests.find((tab) => tab.browserId === sample.browserId);
      return {
        sampleId: sample.sampleId,
        clickTraceTimestampUs: marker.ts,
        hostPid: report.memory.tenPages.host.pid,
        guestPid: guest.pid,
        frameCandidates: compositorEvents
          .filter(
            (event) =>
              event.ts >= marker.ts &&
              event.ts <= marker.ts + (sample.presentationRequestedMs + 100) * 1000 &&
              [guest.pid, report.memory.tenPages.host.pid].includes(event.pid),
          )
          .slice(0, 50),
        attribution:
          "unproven: process/time proximity does not identify presented guest or chrome pixels",
      };
    });
    const require = createRequire(import.meta.url);
    const { registry } = require(
      path.join(
        path.dirname(require.resolve("playwright-core/package.json")),
        "lib/server/registry/index.js",
      ),
    );
    const videoPath = path.join(artifactDir, "tab-switches.webm");
    execFileSync(
      registry.findExecutable("ffmpeg").executablePath(),
      [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        "10",
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
        "-c:v",
        "vp8",
        "-deadline",
        "realtime",
        "-speed",
        "8",
        "-threads",
        "1",
        videoPath,
      ],
      {
        input: Buffer.concat(
          videoFrames.map((frame) => fs.readFileSync(path.join(framesDir, frame.file))),
        ),
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    report.video = {
      file: path.basename(videoPath),
      frames: videoFrames,
      playbackFramesPerSecond: 10,
      note: "Illustrative CDP host screencast; frame timestamps are raw, playback is constant rate and is not latency evidence.",
    };
    assert(videoFrames.length > 1, "Tab-switch video contains no changing frames");
    report.completedAt = new Date().toISOString();
    return report;
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    if (tracing)
      await evaluateMain(
        inspectorPort,
        `process.mainModule.require('electron').contentTracing.stopRecording(${JSON.stringify(tracePath)})`,
      ).catch(() => undefined);
    writeJson(path.join(artifactDir, "tab-switch-video-timestamps.json"), videoFrames);
    writeJson(reportPath, report);
    await cdp.detach();
    // Leave the existing journey's tab cohort independent of the measured ten guests.
    for (const tab of cohort)
      await callBrowserTool(client, "browser_close_tab", { browserId: tab.browserId }).catch(
        () => undefined,
      );
  }
}

async function main() {
  const artifactDir =
    process.env.PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "paseo-desktop-browser-e2e-artifacts-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-desktop-browser-e2e-"));
  fs.mkdirSync(artifactDir, { recursive: true });
  const paseoHome = path.join(runtimeDir, "paseo-home");
  const userData = path.join(runtimeDir, "electron-user-data");
  const workspaceRoot = path.join(runtimeDir, "workspaces");
  fs.mkdirSync(paseoHome, { recursive: true });

  const [daemonPort, expoPort, cdpPort, inspectorPort, remotePort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const listen = `127.0.0.1:${daemonPort}`;
  seedPaseoHome(paseoHome, listen, workspaceRoot);
  const target = await startTargetPage();
  seedPluginLinks(paseoHome, workspaceIds[0], target.url, workspaceIds[1]);
  const remoteHome = path.join(runtimeDir, "remote-home");
  seedPaseoHome(remoteHome, `127.0.0.1:${remotePort}`, path.join(runtimeDir, "remote-workspaces"));
  const children = [];
  let browser = null;
  let page = null;
  let client = null;

  try {
    // Observe the real Electron shell handoff without launching a user's browser.
    const openerDirectory = path.join(runtimeDir, "url-handler");
    const externalOpenLog = path.join(artifactDir, "external-opens.txt");
    fs.mkdirSync(openerDirectory, { recursive: true });
    fs.writeFileSync(externalOpenLog, "");
    fs.writeFileSync(
      path.join(openerDirectory, "xdg-open"),
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$PASEO_TEST_EXTERNAL_OPEN_LOG"\n',
      { mode: 0o755 },
    );
    const commonEnv = {
      ...process.env,
      PATH: `${openerDirectory}${path.delimiter}${process.env.PATH}`,
      PASEO_TEST_EXTERNAL_OPEN_LOG: externalOpenLog,
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

    const remoteDaemon = spawnLogged(
      "remote-daemon",
      process.execPath,
      ["--import", "tsx", path.join(rootDir, "packages/server/scripts/dev-runner.ts")],
      {
        cwd: rootDir,
        env: {
          ...commonEnv,
          PASEO_HOME: remoteHome,
          PASEO_LISTEN: `127.0.0.1:${remotePort}`,
          PASEO_SERVER_ID: "plugin-links-remote",
          PASEO_NODE_ENV: "development",
        },
      },
      artifactDir,
    );
    children.push(remoteDaemon.child);
    await waitForPort(remotePort, "remote daemon", remoteDaemon);

    const desktopArgs = [
      process.execPath,
      devRunner,
      `--inspect=127.0.0.1:${inspectorPort}`,
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
    page = await waitForAppPage(browser, expoPort);
    const initialStatus = await waitForDesktopStatus(page);
    await page.waitForLoadState("load");
    await page
      .getByTestId(`sidebar-workspace-row-${initialStatus.serverId}:${workspaceIds[0]}`)
      .waitFor({ state: "visible", timeout: timeoutMs });
    const rendererEnvironment = await page.evaluate((testPhase) => {
      const key = "@paseo:app-settings";
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      // Existing journey selectors are English; use the app's persisted language setting.
      localStorage.setItem(key, JSON.stringify({ ...settings, language: "en" }));
      if (testPhase === "after")
        localStorage.setItem(
          "@paseo:keyboard-shortcut-overrides",
          JSON.stringify({ "workspace-browser-reopen-last-closed": "Mod+Shift+Y" }),
        );
      return {
        language: navigator.language,
        languages: navigator.languages,
        fixtureLanguage: "en",
      };
    }, phase);
    writeJson(path.join(artifactDir, "renderer-environment.json"), rendererEnvironment);
    await page.reload();
    const status = await waitForDesktopStatus(page);
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .waitFor({ state: "visible", timeout: timeoutMs });

    const reconnect = async () => {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      page = await waitForAppPage(browser, expoPort);
      return page;
    };

    const checkPluginLinks = () =>
      runPluginLinksRegression({
        page,
        remotePort,
        workspaceId: workspaceIds[0],
        remoteWorkspaceId: workspaceIds[1],
        url: target.url,
        artifactDir,
        externalOpenLog: process.platform === "linux" ? externalOpenLog : null,
      });
    if (process.env.PASEO_DESKTOP_PLUGIN_LINKS_ONLY === "1") {
      const pluginLinks = await checkPluginLinks();
      writeJson(path.join(artifactDir, "result.json"), { pluginLinks });
      console.log("Plugin external links and workspace browser passed.");
      return;
    }
    const settingsMemory = await runSettingsMemoryRegression(page);
    if (process.env.PASEO_DESKTOP_SETTINGS_MEMORY_ONLY === "1") {
      writeJson(path.join(artifactDir, "result.json"), { settingsMemory });
      console.log(
        `Desktop Settings memory regression passed: ${settingsMemory.detachedAfterWarmRound} detached panes after warm and stress rotations.`,
      );
      return;
    }

    await runAppearanceFontSizeRegression(page);

    const callerAgentId = await createCallerAgent(daemonPort);
    const typingAgent = {
      workspaceId: workspaceIds.at(-1),
      agentId: await createCallerAgent(daemonPort, workspaceIds.at(-1)),
    };
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${daemonPort}/mcp/agents?callerAgentId=${encodeURIComponent(callerAgentId)}`,
      ),
    );
    client = await experimental_createMCPClient({ transport });
    if (phase === "after") {
      await verifyManualBrowserInsertion({
        page,
        client,
        serverId: status.serverId,
        target,
        artifactDir,
      });
      await verifyPresentationContinuity({
        page,
        client,
        serverId: status.serverId,
        callerAgentId,
        target,
        artifactDir,
        inspectorPort,
        reconnect,
      });
      await verifyUnpresentedBrowserCrash({
        page,
        client,
        target,
        artifactDir,
        inspectorPort,
        evicted: false,
      });
      await verifyUnpresentedBrowserCrash({
        page,
        client,
        target,
        artifactDir,
        inspectorPort,
        evicted: true,
      });
      await verifyBrowserCrash({ page, client, target, artifactDir, inspectorPort });
      await verifyBrowserCloseReopen({
        page,
        client,
        serverId: status.serverId,
        target,
        artifactDir,
        inspectorPort,
      });
      await verifyBrowserOverflow({ page, client, target, artifactDir, inspectorPort });
    }
    if (phase === "after") {
      const placementClient = await experimental_createMCPClient({
        transport: new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${daemonPort}/mcp/agents?callerAgentId=${encodeURIComponent(typingAgent.agentId)}`,
          ),
        ),
      });
      try {
        await verifyBrowserPlacementError({
          page,
          client: placementClient,
          serverId: status.serverId,
          typingAgent,
          artifactDir,
        });
      } finally {
        await placementClient.close();
      }
    }
    if (phase === "after")
      await verifyBrowserLastOrdinary({ page, serverId: status.serverId, artifactDir });
    await runTabBaseline({
      page,
      client,
      serverId: status.serverId,
      target,
      artifactDir,
      inspectorPort,
    });
    const report = await runRegression({
      page,
      client,
      serverId: status.serverId,
      targetUrl: target.url,
      inspectorPort,
      reconnect,
      callerAgentId,
      typingAgent,
      artifactDir,
    });
    const pluginLinks = await checkPluginLinks();
    if (phase === "after")
      await verifyBrowserFinalLifecycle({
        page,
        client,
        serverId: status.serverId,
        callerAgentId,
        target,
        artifactDir,
        inspectorPort,
      });
    writeJson(path.join(artifactDir, "result.json"), {
      ...report,
      phase,
      tabBaselineFile: `browser-tabs-${phase}.json`,
      settingsMemory,
      pluginLinks,
    });
    console.log(
      `Browser desktop browser E2E passed: WebContents ${report.originalWebContentsId} remained ${report.finalWebContentsId}; viewport, inactive capture, focus continuity, list, snapshot, click, local-page selectors passed.`,
    );
  } catch (error) {
    console.error(`Browser desktop browser E2E failed. Artifacts: ${artifactDir}`);
    console.error(error);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifactDir, "failure.png") }).catch(() => undefined);
      const state = await page
        .evaluate(() => ({
          url: location.href,
          language: navigator.language,
          languages: navigator.languages,
          text: document.body.innerText,
          buttons: [...document.querySelectorAll('button,[role="button"]')].map((element) => ({
            text: element.textContent,
            label: element.getAttribute("aria-label"),
          })),
        }))
        .catch(() => null);
      writeJson(path.join(artifactDir, "failure-renderer.json"), state);
    }
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
