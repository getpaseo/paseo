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
import { runAppearanceFontSizeRegression } from "./appearance-font-size.electron.mjs";

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
        <head><title>Desktop browser target</title></head>
        <body>
          <button id="bridge-target" onclick="this.textContent = 'Clicked'">Bridge target</button>
          <label for="typing-target">Typing target</label>
          <input id="typing-target" />
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
    function: "() => ({ width: window.innerWidth, height: window.innerHeight })",
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
  const webviewRect = await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) return null;
    const rect = webview.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  }, browserId);
  assert(webviewRect, `Browser webview ${browserId} was unavailable`);
  await page.mouse.click(
    webviewRect.x + elementRect.x + elementRect.width / 2,
    webviewRect.y + elementRect.y + elementRect.height / 2,
  );
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

function recordViewportMismatch(failures, label, actual, expected) {
  if (actual.width === expected.width && actual.height === expected.height) {
    return;
  }
  failures.push(
    `${label}: expected ${expected.width}x${expected.height}, received ${actual.width}x${actual.height}`,
  );
}

async function runRegression({ page, client, serverId, targetUrl, callerAgentId }) {
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
      return webview && webview.parentElement?.id !== "paseo-browser-resident-webviews";
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
  const activeGuestElement = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => document.activeElement?.id ?? null",
  });
  assert(
    JSON.parse(activeGuestElement.resultJson) === "typing-target",
    "Physical browser click did not focus the guest input",
  );
  const focusedGuest = await page.evaluate(
    (id) => window.paseoDesktop?.browser?.focus?.(id),
    browserId,
  );
  assert(focusedGuest === true, "Electron did not focus the registered browser guest");

  const deviceSizeMenuPainted = await selectDeviceSize(page, "iPhone SE · 375×667");
  assert(deviceSizeMenuPainted, "Device size menu did not paint above the browser surface");
  recordViewportMismatch(
    failures,
    "device size menu paints and receives input above the browser surface",
    await readViewport(client, browserId),
    { width: 375, height: 667 },
  );

  await callBrowserTool(client, "browser_wait", {
    browserId,
    text: "Bridge target",
    timeoutMs: 5_000,
  });
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
  await page.waitForTimeout(500);
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

  await originalDeck.getByRole("button", { name: "Annotate element" }).click();
  await page.waitForTimeout(250);
  const selectorResult = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => Boolean(globalThis.__paseoSelector)",
  });
  if (JSON.parse(selectorResult.resultJson) !== true) {
    failures.push("reused loaded browser remains ready for element annotation after remount");
  }

  await clickGuestElement(page, client, browserId, "#bridge-target");
  const annotationInput = originalDeck.getByPlaceholder("Message to the agent about this element…");
  await annotationInput.waitFor({ state: "visible", timeout: timeoutMs });
  const annotationInputBounds = await annotationInput.boundingBox();
  const browserClipBounds = await originalDeck
    .getByTestId(`browser-webview-clip-${browserId}`)
    .boundingBox();
  assert(annotationInputBounds, "Element annotation input had no bounds");
  assert(browserClipBounds, "Browser pane had no bounds while annotating an element");
  assert(
    annotationInputBounds.x >= browserClipBounds.x &&
      annotationInputBounds.y >= browserClipBounds.y &&
      annotationInputBounds.x + annotationInputBounds.width <=
        browserClipBounds.x + browserClipBounds.width &&
      annotationInputBounds.y + annotationInputBounds.height <=
        browserClipBounds.y + browserClipBounds.height,
    "Element annotation input is outside the browser pane",
  );
  await originalDeck.getByRole("button", { name: "Cancel" }).click();

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
    list: "passed",
    snapshot: "passed",
    click: "passed",
  };
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

    await runAppearanceFontSizeRegression(page);

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
      callerAgentId,
    });
    writeJson(path.join(artifactDir, "result.json"), report);
    console.log(
      `Browser desktop browser E2E passed: WebContents ${report.originalWebContentsId} remained ${report.finalWebContentsId}; viewport, inactive capture, focus continuity, list, snapshot, click passed.`,
    );
  } catch (error) {
    console.error(`Browser desktop browser E2E failed. Artifacts: ${artifactDir}`);
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
