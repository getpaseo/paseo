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
  const server = createServer((request, response) => {
    const fixtureId = new URL(request.url, "http://localhost").searchParams.get("fixture");
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
  return { server, url: `http://127.0.0.1:${address.port}/`, httpLoadCounts };
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

async function verifyHiddenBrowserScreenshots({
  page,
  client,
  browserId,
  artifactDir,
  inspectorPort,
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
  try {
    await expectAnimation();
    await setWindowHidden(inspectorPort, true);
    await expectIdle("before-capture");
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
    const pixel = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return [
        ...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1)
          .data,
      ];
    }, screenshot.data);
    assert(
      JSON.stringify(pixel) === "[0,255,0,255]",
      `Hidden screenshot returned stale pixels: ${pixel}`,
    );
    await expectIdle("after-capture");
  } finally {
    await setWindowHidden(inspectorPort, false);
  }
  await expectAnimation();
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
}) {
  const failures = [];
  const originalWorkspaceId = workspaceIds[0];
  const originalWorkspaceRow = page.getByTestId(
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

  const originalDeck = page.getByTestId(`workspace-deck-entry-${serverId}:${originalWorkspaceId}`);
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
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

  await verifyHiddenBrowserScreenshots({ page, client, browserId, artifactDir, inspectorPort });

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
  await page.getByTestId("sidebar-search").click();
  await page.getByTestId("command-center-input").fill("Split pane right");
  await page.getByText("Split pane right", { exact: true }).click();
  assert(
    (await originalDeck.getByTestId("workspace-tabs-row").filter({ visible: true }).count()) === 2,
    "Split pane command did not produce two visible panes",
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

async function readRendererMemory(page, inspectorPort, cohort) {
  const guests = await Promise.all(
    cohort.map(async (tab) => ({
      ...tab,
      webContentsId: (await readGuest(page, tab.browserId))?.webContentsId ?? null,
    })),
  );
  return await evaluateMain(
    inspectorPort,
    `(() => {
    const { app, webContents, BrowserWindow } = process.mainModule.require('electron');
    const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')).webContents;
    const guests = ${JSON.stringify(guests)}.map(tab => {
      const guest = tab.webContentsId === null ? null : webContents.fromId(tab.webContentsId);
      return { ...tab, pid: guest && !guest.isDestroyed() ? guest.getOSProcessId() : null };
    });
    const rawMetrics = app.getAppMetrics();
    const guestPids = [...new Set(guests.map(tab => tab.pid).filter(Boolean))];
    const cohortRendererMetrics = rawMetrics.filter(metric => guestPids.includes(metric.pid));
    return { capturedAt: new Date().toISOString(), guests, guestPids, host: { webContentsId: host.id, pid: host.getOSProcessId() },
      hostRendererMetric: rawMetrics.find(metric => metric.pid === host.getOSProcessId()), cohortRendererMetrics,
      cohortWorkingSetSizeKiB: cohortRendererMetrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
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
    report.memory.idle = await readRendererMemory(page, inspectorPort, cohort);
    for (let index = 0; index < 10; index++) {
      const fixtureId = `measurement-${index}`;
      const created = await callBrowserTool(client, "browser_new_tab", {
        url: `${target.url}?fixture=${fixtureId}`,
      });
      cohort.push({ browserId: created.browserId, fixtureId });
      await callBrowserTool(client, "browser_evaluate", {
        browserId: created.browserId,
        function: "() => document.readyState",
      });
      if (index === 1) {
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
        for (let switchIndex = 0; switchIndex < 20; switchIndex++) {
          await measureTabSwitch(
            page,
            cohort[(switchIndex + 1) % 2].browserId,
            `continuity-${switchIndex}`,
          );
        }
        report.continuity = { tabs: [], switches: 20 };
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
    report.memory.tenPages = await readRendererMemory(page, inspectorPort, cohort);
    assert(
      report.memory.tenPages.guests.every((tab) => tab.pid),
      "Memory cohort has a missing guest PID",
    );
    for (const tab of cohort.slice(1))
      await callBrowserTool(client, "browser_close_tab", { browserId: tab.browserId });
    await delay(10_000);
    report.memory.afterClosingNine = await readRendererMemory(page, inspectorPort, cohort);
    assert(
      report.memory.afterClosingNine.guests.filter((tab) => tab.pid).length === 1,
      "Closed cohort guests remained registered",
    );
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
    const rendererEnvironment = await page.evaluate(() => {
      const key = "@paseo:app-settings";
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      // Existing journey selectors are English; use the app's persisted language setting.
      localStorage.setItem(key, JSON.stringify({ ...settings, language: "en" }));
      return {
        language: navigator.language,
        languages: navigator.languages,
        fixtureLanguage: "en",
      };
    });
    writeJson(path.join(artifactDir, "renderer-environment.json"), rendererEnvironment);
    await page.reload();
    const status = await waitForDesktopStatus(page);
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .waitFor({ state: "visible", timeout: timeoutMs });

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
      callerAgentId,
      typingAgent,
      artifactDir,
    });
    const pluginLinks = await checkPluginLinks();
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
