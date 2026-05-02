import { expect, test, type Page } from "@playwright/test";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const OUTPUT_DIR =
  process.env.PASEO_ELECTRON_FIND_QA_OUTPUT_DIR ?? "/tmp/paseo-find-pane-electron-rerun";
const PASEO_HOME = path.join(OUTPUT_DIR, "home");
const USER_DATA_DIR = path.join(OUTPUT_DIR, "electron-user-data");
const QA_PAGE_TEXT = [
  "Electron Webview Find QA",
  "alpha electronneedle first",
  "beta no match",
  "gamma electronneedle second",
  "delta ELECTRONNEEDLE third",
].join("\n\n");
const QA_PAGE_HTML = `<!doctype html><html><head><title>Find QA Page</title><style>body{font:16px system-ui;padding:32px}p{margin:24px 0}</style></head><body><main><h1>Electron Webview Find QA</h1><p>alpha electronneedle first</p><p>beta no match</p><p>gamma electronneedle second</p><p>delta ELECTRONNEEDLE third</p></main></body></html>`;

function rootEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.npm_config_workspace;
  delete env.npm_config_workspaces;
  delete env.npm_package_name;
  delete env.npm_lifecycle_event;
  delete env.npm_lifecycle_script;
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";
  env.npm_config_color = "false";
  return env;
}

interface ElectronProcess {
  child: ChildProcessWithoutNullStreams;
  cdpPort: number;
  metroPort: number;
  logs: string[];
}

interface QaEvidence {
  timestamps: Record<string, number>;
  domReadyEvents: Array<{ ts: number }>;
  listenerSnapshots: Record<string, Record<string, number>>;
  findCalls: Array<{
    text: string;
    options: Record<string, unknown>;
    requestId: number | null;
    ts: number;
  }>;
  stopCalls: Array<{ action: string; ts: number }>;
  foundEvents: Array<{ result: unknown; ts: number }>;
  manualFoundEvents: Array<{ result: unknown; ts: number }>;
  webview: {
    url: string | null;
    text: string | null;
    webContentsId: number | null;
    findInPageType: string | null;
    stopFindInPageType: string | null;
    domReady: boolean;
  };
  app: {
    url: string;
    bodyText: string;
    logboxCount: number;
    findBarText: string | null;
    findInputValue: string | null;
  };
  process: {
    cdpPort: number;
    metroPort: number;
    daemonListen: string | null;
    serverId: string | null;
  };
  sources: {
    browserPaneElectron: string[];
    preload: string[];
    main: string[];
    browserWebviews: string[];
    electronDocs: string[];
  };
  hypothesis: string;
  cheapestFixShape: string;
}

function now(): number {
  return Date.now();
}

function encodeWorkspaceId(workspaceId: string): string {
  return `b64_${Buffer.from(workspaceId, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")}`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function execFileText(
  command: string,
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: REPO_ROOT, env: rootEnv(env) }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed\n${stdout}\n${stderr}`));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

function parseJsonObjectFromOutput(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`No JSON object found in command output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

async function waitFor<T>(
  label: string,
  callback: () => Promise<T | null>,
  timeoutMs = 45_000,
): Promise<T> {
  const started = now();
  let lastError: unknown = null;
  while (now() - started < timeoutMs) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function startStaticServer(): Promise<{ server: Server; port: number }> {
  const port = await freePort();
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(QA_PAGE_HTML);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return { server, port };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startElectron(): Promise<ElectronProcess> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const cdpPort = await freePort();
  const logs: string[] = [];
  const child = spawn("npm", ["--prefix", REPO_ROOT, "run", "dev:desktop"], {
    cwd: REPO_ROOT,
    env: rootEnv({
      PASEO_HOME,
      PASEO_ELECTRON_USER_DATA_DIR: USER_DATA_DIR,
      PASEO_LISTEN: "127.0.0.1:0",
      PASEO_ELECTRON_FLAGS: `--remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const append = (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  let metroPort: number;
  try {
    metroPort = await waitFor("desktop dev Metro port", async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`desktop process exited early: ${child.exitCode ?? child.signalCode}`);
      }
      const logText = logs.join("");
      const match =
        logText.match(/Metro:\s+http:\/\/localhost:(\d+)/) ??
        logText.match(/Waiting on\s+http:\/\/localhost:(\d+)/);
      return match ? Number(match[1]) : null;
    });

    await waitFor("Electron CDP endpoint", async () => {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => null);
      return response?.ok ? true : null;
    });
  } catch (error) {
    await writeFile(path.join(OUTPUT_DIR, "electron-dev-start-failure.log"), logs.join(""), "utf8");
    throw error;
  }

  return { child, cdpPort, metroPort, logs };
}

async function stopElectron(input: ElectronProcess): Promise<void> {
  if (input.child.exitCode === null && input.child.signalCode === null) {
    input.child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    input.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await writeFile(path.join(OUTPUT_DIR, "electron-dev.log"), input.logs.join(""), "utf8");
  await execFileText("npm", ["--prefix", REPO_ROOT, "run", "cli", "--", "daemon", "stop"], {
    PASEO_HOME,
  }).catch(async (error) => {
    await writeFile(path.join(OUTPUT_DIR, "daemon-stop-error.txt"), String(error), "utf8");
  });
}

async function readServerId(): Promise<string> {
  return (await readFile(path.join(PASEO_HOME, "server-id"), "utf8")).trim();
}

async function readDaemonListen(): Promise<string | null> {
  const output = await execFileText(
    "npm",
    ["--prefix", REPO_ROOT, "run", "cli", "--", "daemon", "status"],
    {
      PASEO_HOME,
    },
  );
  const match = output.match(/Listen\s+([^\s]+)/);
  return match?.[1] ?? null;
}

async function createMockAgent(): Promise<string> {
  const output = await execFileText(
    "npm",
    [
      "--prefix",
      REPO_ROOT,
      "run",
      "cli",
      "--",
      "run",
      "--provider",
      "mock",
      "--mode",
      "load-test",
      "--cwd",
      REPO_ROOT,
      "--title",
      "Electron browser find QA",
      "-d",
      "electron browser find qa",
      "--json",
    ],
    { PASEO_HOME },
  );
  const parsed = parseJsonObjectFromOutput(output) as { agentId?: string };
  if (!parsed.agentId) {
    throw new Error(`Mock agent output did not include agentId:\n${output}`);
  }
  return parsed.agentId;
}

async function screenshot(page: Page, name: string): Promise<string> {
  const filePath = path.join(OUTPUT_DIR, name);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function getListenerCounts(page: Page): Promise<Record<string, number>> {
  const client = await page.context().newCDPSession(page);
  const evaluated = await client.send("Runtime.evaluate", {
    expression: "document.querySelector('webview')",
    objectGroup: "paseo-find-qa",
  });
  const objectId = evaluated.result.objectId;
  if (!objectId) return {};
  const listeners = await client.send("DOMDebugger.getEventListeners", { objectId });
  await client.send("Runtime.releaseObjectGroup", { objectGroup: "paseo-find-qa" });
  return listeners.listeners.reduce<Record<string, number>>((acc, listener) => {
    acc[listener.type] = (acc[listener.type] ?? 0) + 1;
    return acc;
  }, {});
}

async function collectEvidence(
  page: Page,
  processInfo: ElectronProcess,
  daemonListen: string | null,
  serverId: string | null,
  listenerSnapshots: Record<string, Record<string, number>>,
): Promise<QaEvidence> {
  const runtime = await page.evaluate(async () => {
    const webview = document.querySelector("webview") as
      | (HTMLElement & {
          getURL?: () => string;
          getWebContentsId?: () => number;
          executeJavaScript?: (code: string) => Promise<unknown>;
          findInPage?: unknown;
          stopFindInPage?: unknown;
        })
      | null;
    const input = document.querySelector(
      "[data-testid='pane-find-input']",
    ) as HTMLInputElement | null;
    return {
      app: {
        url: location.href,
        bodyText: document.body.innerText,
        logboxCount: document.querySelectorAll("[data-testid='logbox_title']").length,
        findBarText: document.querySelector("[data-testid='pane-find-bar']")?.textContent ?? null,
        findInputValue: input?.value ?? null,
      },
      webview: {
        url: webview?.getURL?.() ?? null,
        text: webview?.executeJavaScript
          ? ((await webview.executeJavaScript("document.body.innerText")) as string)
          : null,
        webContentsId: webview?.getWebContentsId?.() ?? null,
        findInPageType: typeof webview?.findInPage,
        stopFindInPageType: typeof webview?.stopFindInPage,
        domReady: Boolean(window.__paseoElectronFindQa?.domReady),
      },
      qa: window.__paseoElectronFindQa ?? {
        timestamps: {},
        domReadyEvents: [],
        findCalls: [],
        stopCalls: [],
        foundEvents: [],
        manualFoundEvents: [],
      },
    };
  });

  return {
    timestamps: runtime.qa.timestamps,
    domReadyEvents: runtime.qa.domReadyEvents,
    listenerSnapshots,
    findCalls: runtime.qa.findCalls,
    stopCalls: runtime.qa.stopCalls,
    foundEvents: runtime.qa.foundEvents,
    manualFoundEvents: runtime.qa.manualFoundEvents,
    webview: runtime.webview,
    app: runtime.app,
    process: {
      cdpPort: processInfo.cdpPort,
      metroPort: processInfo.metroPort,
      daemonListen,
      serverId,
    },
    sources: {
      browserPaneElectron: [
        "packages/app/src/components/browser-pane.electron.tsx:450-460 calls renderer webview.findInPage and stores the numeric requestId.",
        "packages/app/src/components/browser-pane.electron.tsx:602-607 marks dom-ready and retries a pending query.",
        "packages/app/src/components/browser-pane.electron.tsx:622-623 attaches renderer dom-ready and found-in-page listeners.",
      ],
      preload: [
        "packages/desktop/src/preload.ts:60-62 exposes browser.setActivePane only; there is no find bridge.",
      ],
      main: [
        "packages/desktop/src/main.ts:340-345 receives did-attach-webview and registers the WebContents.",
        "packages/desktop/src/main.ts:345-365 forwards selected browser keyboard shortcuts, but does not forward find results.",
      ],
      browserWebviews: [
        "packages/desktop/src/features/browser-webviews.ts:6-20 maps browserId to WebContents.",
        "packages/desktop/src/features/browser-webviews.ts:27-38 can return the active browser WebContents.",
      ],
      electronDocs: [
        "https://www.electronjs.org/docs/latest/api/webview-tag#event-found-in-page documents renderer <webview> found-in-page for webview.findInPage.",
        "https://www.electronjs.org/docs/latest/api/web-contents#event-found-in-page documents main-process webContents found-in-page for contents.findInPage.",
      ],
    },
    hypothesis:
      "The renderer <webview> wrapper exposes findInPage and returns request IDs, but this Electron 41 sandboxed webview path is not delivering renderer-side found-in-page events.",
    cheapestFixShape:
      "Move browser find execution/result collection to the already-registered guest WebContents in the main process, then expose a narrow preload bridge that accepts browserId/query/navigation commands and emits found-in-page results back to the renderer; keep the existing FindBar state machine but stop depending on renderer <webview> found-in-page delivery.",
  };
}

async function writeDiagnostic(evidence: QaEvidence): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(OUTPUT_DIR, `diagnostic-${timestamp}.md`);
  const foundListenerBeforeFind = evidence.listenerSnapshots.beforeFind?.["found-in-page"] ?? 0;
  const sourceReferenceLines: string[] = [];
  for (const [group, refs] of Object.entries(evidence.sources)) {
    sourceReferenceLines.push(`### ${group}`, "");
    for (const ref of refs) {
      sourceReferenceLines.push(`- ${ref}`);
    }
    sourceReferenceLines.push("");
  }
  const lines = [
    "# Electron Browser Find Diagnostic",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Run",
    "",
    `- Metro: http://localhost:${evidence.process.metroPort}`,
    `- CDP: http://127.0.0.1:${evidence.process.cdpPort}`,
    `- Daemon: ${evidence.process.daemonListen ?? "<unknown>"}`,
    `- Server ID: ${evidence.process.serverId ?? "<unknown>"}`,
    `- Webview URL: ${evidence.webview.url ?? "<missing>"}`,
    "",
    "## Findings",
    "",
    `- dom-ready before findInPage: ${evidence.timestamps.domReady && evidence.timestamps.firstFindCall ? evidence.timestamps.domReady <= evidence.timestamps.firstFindCall : false}`,
    `- dom-ready timestamp: ${evidence.timestamps.domReady ?? "<missing>"}`,
    `- first findInPage timestamp: ${evidence.timestamps.firstFindCall ?? "<missing>"}`,
    `- renderer found-in-page listener count before find: ${foundListenerBeforeFind}`,
    `- webview.findInPage typeof: ${evidence.webview.findInPageType}`,
    `- webview.stopFindInPage typeof: ${evidence.webview.stopFindInPageType}`,
    `- webview.getWebContentsId(): ${evidence.webview.webContentsId ?? "<missing>"}`,
    `- findInPage calls: ${JSON.stringify(evidence.findCalls)}`,
    `- found-in-page events observed by renderer listeners: ${JSON.stringify(evidence.foundEvents)}`,
    `- manual renderer found-in-page events after direct second findInPage: ${JSON.stringify(evidence.manualFoundEvents)}`,
    `- UI find bar text: ${JSON.stringify(evidence.app.findBarText)}`,
    `- UI input value: ${JSON.stringify(evidence.app.findInputValue)}`,
    `- LogBox count: ${evidence.app.logboxCount}`,
    "",
    "## Event Pattern",
    "",
    "- Electron documents both renderer `<webview>.addEventListener('found-in-page', ...)` for `webview.findInPage()` and main-process `webContents.on('found-in-page', ...)` for `contents.findInPage()`.",
    "- This codebase currently uses the renderer `<webview>` pattern: `browser-pane.electron.tsx:450-460` calls `webview.findInPage`, and `browser-pane.electron.tsx:622-623` attaches `found-in-page` directly to the `<webview>` element.",
    "- The preload bridge only exposes `browser.setActivePane` (`packages/desktop/src/preload.ts:60-62`); it does not expose a find command or result channel.",
    "- The main process already registers the guest WebContents (`packages/desktop/src/main.ts:340-345`, `packages/desktop/src/features/browser-webviews.ts:6-20`) but does not listen for `found-in-page`.",
    "",
    "## Source References",
    "",
    ...sourceReferenceLines,
    "## Hypothesis",
    "",
    evidence.hypothesis,
    "",
    "## Cheapest Fix Shape",
    "",
    evidence.cheapestFixShape,
    "",
  ];
  await writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

test.describe("Electron browser in-pane find", () => {
  test("forwards Cmd+F find to the Electron webview and reports native found-in-page results", async () => {
    test.setTimeout(150_000);

    let staticServer: Server | null = null;
    let electron: ElectronProcess | null = null;
    let browser: Browser | null = null;
    let evidence: QaEvidence | null = null;
    let diagnosticPath: string | null = null;
    const listenerSnapshots: Record<string, Record<string, number>> = {};

    try {
      const staticSite = await startStaticServer();
      staticServer = staticSite.server;
      electron = await startElectron();
      const daemonListen = await waitFor("isolated desktop daemon", readDaemonListen, 45_000);
      if (daemonListen === "127.0.0.1:6767" || daemonListen === "localhost:6767") {
        throw new Error("Refusing to run Electron find QA against port 6767.");
      }
      const serverId = await readServerId();
      const agentId = await createMockAgent();

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${electron.cdpPort}`);
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("Unable to find Electron renderer page over CDP.");

      const workspaceRoute = `http://localhost:${electron.metroPort}/h/${serverId}/workspace/${encodeWorkspaceId(
        REPO_ROOT,
      )}?open=${encodeURIComponent(`agent:${agentId}`)}`;
      await page.goto(workspaceRoute);
      await page
        .getByTestId("workspace-new-browser")
        .waitFor({ state: "visible", timeout: 30_000 });
      await screenshot(page, "electron-find-01-workspace.png");

      await page.getByTestId("workspace-new-browser").click();
      await page.locator("webview").waitFor({ state: "attached", timeout: 15_000 });
      await page.waitForTimeout(1_000);
      await screenshot(page, "electron-find-02-browser-opened.png");
      await expect(page.getByTestId("logbox_title")).toHaveCount(0);

      listenerSnapshots.afterBrowserOpen = await getListenerCounts(page);

      await page.evaluate(() => {
        const webview = document.querySelector("webview") as
          | (HTMLElement & {
              findInPage?: (text: string, options?: Record<string, unknown>) => number;
              stopFindInPage?: (action: string) => void;
            })
          | null;
        if (!webview?.findInPage || !webview.stopFindInPage) {
          throw new Error("webview find API is unavailable");
        }
        const qa: NonNullable<Window["__paseoElectronFindQa"]> = {
          timestamps: { instrumentationAttached: Date.now() },
          domReadyEvents: [],
          findCalls: [],
          stopCalls: [],
          foundEvents: [],
          manualFoundEvents: [],
          domReady: false,
        };
        window.__paseoElectronFindQa = qa;
        const recordDomReady = () => {
          qa.domReady = true;
          qa.timestamps.domReady = Date.now();
          qa.domReadyEvents.push({ ts: Date.now() });
        };
        const recordFoundInPage = (event: Event & { result?: unknown }) => {
          qa.foundEvents.push({
            result: event.result ?? null,
            ts: Date.now(),
          });
        };
        webview.addEventListener("dom-ready", recordDomReady);
        webview.addEventListener("found-in-page", recordFoundInPage);
        const originalFind = webview.findInPage.bind(webview);
        const originalStop = webview.stopFindInPage.bind(webview);
        webview.findInPage = (text: string, options?: Record<string, unknown>) => {
          const requestId = originalFind(text, options);
          const ts = Date.now();
          qa.timestamps.firstFindCall ??= ts;
          qa.findCalls.push({
            text,
            options: { ...options },
            requestId: typeof requestId === "number" ? requestId : null,
            ts,
          });
          return requestId;
        };
        webview.stopFindInPage = (action: string) => {
          qa.stopCalls.push({ action, ts: Date.now() });
          return originalStop(action);
        };
      });

      listenerSnapshots.afterInstrumentation = await getListenerCounts(page);

      const urlInput = page.getByRole("textbox", { name: "Browser URL" });
      await urlInput.fill(`http://127.0.0.1:${staticSite.port}/index.html`);
      await urlInput.press("Enter");
      await page.waitForFunction(
        (port) => {
          const webview = document.querySelector("webview") as
            | (Element & { getURL?: () => string })
            | null;
          return webview?.getURL?.().includes(`127.0.0.1:${port}`);
        },
        staticSite.port,
        { timeout: 15_000 },
      );
      await page.waitForFunction(() => window.__paseoElectronFindQa?.domReady === true, null, {
        timeout: 15_000,
      });
      await screenshot(page, "electron-find-03-page-loaded.png");

      listenerSnapshots.beforeFind = await getListenerCounts(page);

      const box = await page.locator("webview").boundingBox();
      if (!box) throw new Error("webview has no bounding box");
      await page.mouse.click(
        box.x + Math.min(120, box.width / 2),
        box.y + Math.min(120, box.height / 2),
      );
      await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
      await page.getByTestId("pane-find-bar").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("pane-find-input").fill("electronneedle");

      await page.waitForFunction(
        () => (window.__paseoElectronFindQa?.foundEvents?.length ?? 0) > 0,
        null,
        { timeout: 10_000 },
      );
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await screenshot(page, "electron-find-04-query.png");

      await page.getByTestId("pane-find-next").click();
      await expect(page.getByText("2 / 3")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-prev").click();
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-input").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("2 / 3")).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Shift+Enter");
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("pane-find-bar")).toHaveCount(0);

      await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
      await page.getByTestId("pane-find-input").fill("electronneedle");
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-close").click();
      await expect(page.getByTestId("pane-find-bar")).toHaveCount(0);

      evidence = await collectEvidence(page, electron, daemonListen, serverId, listenerSnapshots);
      await writeFile(
        path.join(OUTPUT_DIR, "electron-find-evidence.json"),
        JSON.stringify(evidence, null, 2),
        "utf8",
      );
      diagnosticPath = await writeDiagnostic(evidence);
      await screenshot(page, "electron-find-05-closed.png");
    } catch (error) {
      if (browser && electron) {
        const page = browser.contexts()[0]?.pages()[0];
        if (page) {
          const daemonListen = await readDaemonListen().catch(() => null);
          const serverId = await readServerId().catch(() => null);
          await screenshot(page, "electron-find-failure-state.png").catch(() => undefined);
          evidence = await collectEvidence(
            page,
            electron,
            daemonListen,
            serverId,
            listenerSnapshots,
          );
          await writeFile(
            path.join(OUTPUT_DIR, "electron-find-evidence.json"),
            JSON.stringify(evidence, null, 2),
            "utf8",
          );
          diagnosticPath = await writeDiagnostic(evidence);
        }
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nDiagnostic: ${
          diagnosticPath ?? "<not written>"
        }`,
        { cause: error },
      );
    } finally {
      await browser?.close().catch(() => undefined);
      if (electron) await stopElectron(electron);
      if (staticServer) await stopServer(staticServer);
    }

    expect(evidence?.webview.text).toBe(QA_PAGE_TEXT);
    expect(evidence?.foundEvents.length).toBeGreaterThan(0);
  });
});

declare global {
  interface Window {
    __paseoElectronFindQa?: {
      timestamps: Record<string, number>;
      domReadyEvents: Array<{ ts: number }>;
      findCalls: Array<{
        text: string;
        options: Record<string, unknown>;
        requestId: number | null;
        ts: number;
      }>;
      stopCalls: Array<{ action: string; ts: number }>;
      foundEvents: Array<{ result: unknown; ts: number }>;
      manualFoundEvents: Array<{ result: unknown; ts: number }>;
      domReady: boolean;
    };
  }
}
