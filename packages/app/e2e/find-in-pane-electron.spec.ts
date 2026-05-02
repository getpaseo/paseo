import { expect, test, type Page } from "@playwright/test";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron as electronDriver, type ElectronApplication } from "playwright";
import { connectWorkspaceSetupClient } from "./helpers/workspace-setup";
import { createTempGitRepo } from "./helpers/workspace";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const OUTPUT_DIR =
  process.env.PASEO_ELECTRON_FIND_QA_OUTPUT_DIR ?? "/tmp/paseo-find-pane-electron-rerun";
const RUN_ID = `${process.pid}-${Date.now()}`;
const PASEO_HOME = path.join(OUTPUT_DIR, `home-${RUN_ID}`);
const USER_DATA_DIR = path.join(OUTPUT_DIR, `electron-user-data-${RUN_ID}`);
let paseoListen = "127.0.0.1:0";
const QA_PAGE_TEXT = [
  "Electron Webview Find QA",
  "alpha electronneedle first",
  "beta no match",
  "gamma electronneedle second",
  "delta ELECTRONNEEDLE third",
  "experiment_only_marker",
  "focus_test_a",
  "focus_test_b",
  "control_repeat_unique",
  "control_after_reload",
].join("\n\n");
const QA_PAGE_HTML = `<!doctype html><html><head><title>Find QA Page</title><style>body{font:16px system-ui;padding:32px}p{margin:24px 0}</style></head><body><main><h1>Electron Webview Find QA</h1><p>alpha electronneedle first</p><p>beta no match</p><p>gamma electronneedle second</p><p>delta ELECTRONNEEDLE third</p><p>experiment_only_marker</p><p>focus_test_a</p><p>focus_test_b</p><p>control_repeat_unique</p><p>control_after_reload</p></main></body></html>`;

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

function electronLaunchEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rootEnv(extra)).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

interface ElectronProcess {
  app: ElectronApplication;
  metroChild: ChildProcessWithoutNullStreams;
  cdpPort: number;
  metroPort: number;
  logs: string[];
}

interface TempRepo {
  path: string;
  cleanup: () => Promise<void>;
}

interface WorkspaceSetupClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  openProject(cwd: string): Promise<{
    workspace: {
      id: string;
      name: string;
      workspaceDirectory: string;
      projectRootPath: string;
    } | null;
    error: string | null;
  }>;
}

interface PageSnapshot {
  url: string;
  title: string;
  bodyText: string | null;
}

interface QaEvidence {
  timestamps: Record<string, number>;
  pages: PageSnapshot[];
  selectedPage: PageSnapshot;
  bridge: {
    available: boolean;
    findInPageType: string | null;
    stopFindInPageType: string | null;
    onFoundInPageType: string | null;
    findCalls: Array<{
      browserId: string;
      text: string;
      options: Record<string, unknown>;
      requestId: number | null;
      ts: number;
    }>;
    stopCalls: Array<{ browserId: string; action: string; ts: number }>;
    listenerRegistrations: Array<{ browserId: string; ts: number }>;
    foundEvents: Array<{ browserId: string; result: unknown; ts: number }>;
  };
  mainProcess: {
    installed: boolean;
    ipcHandleWraps: Array<{ channel: string; ok: boolean; reason?: string }>;
    ipcFindCalls: Array<{ args: unknown[]; ts: number; requestId: number | null }>;
    ipcStopCalls: Array<{ args: unknown[]; ts: number }>;
    guestFoundInPageEvents: Array<{ id: number; url: string; result: unknown; ts: number }>;
    ownerForwards: Array<{ id: number; channel: string; payload: unknown; ts: number }>;
    webContentsCreated: Array<{ id: number; type: string; url: string; ts: number }>;
  } | null;
  webview: {
    url: string | null;
    text: string | null;
    webContentsId: number | null;
    findInPageType: string | null;
    stopFindInPageType: string | null;
  };
  app: {
    url: string;
    title: string;
    bodyText: string;
    logboxCount: number;
    findBarText: string | null;
    findInputValue: string | null;
    counterText: string | null;
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
  const metroPort = await freePort();
  const logs: string[] = [];

  await execFileText("npm", [
    "--prefix",
    REPO_ROOT,
    "run",
    "build:main",
    "--workspace=@getpaseo/desktop",
  ]);

  const metroChild = spawn("npx", ["expo", "start", "--port", String(metroPort)], {
    cwd: path.join(REPO_ROOT, "packages/app"),
    env: rootEnv({ PASEO_WEB_PLATFORM: "electron" }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const append = (chunk: Buffer) => {
    logs.push(chunk.toString());
  };
  metroChild.stdout.on("data", append);
  metroChild.stderr.on("data", append);

  try {
    await waitFor("Metro dev server", async () => {
      if (metroChild.exitCode !== null || metroChild.signalCode !== null) {
        throw new Error(
          `metro process exited early: ${metroChild.exitCode ?? metroChild.signalCode}`,
        );
      }
      const response = await fetch(`http://127.0.0.1:${metroPort}`).catch(() => null);
      return response ? true : null;
    });
  } catch (error) {
    await writeFile(path.join(OUTPUT_DIR, "electron-dev-start-failure.log"), logs.join(""), "utf8");
    throw error;
  }

  const app = await electronDriver.launch({
    args: [path.join(REPO_ROOT, "packages/desktop")],
    cwd: REPO_ROOT,
    env: electronLaunchEnv({
      PASEO_HOME,
      PASEO_ELECTRON_USER_DATA_DIR: USER_DATA_DIR,
      PASEO_LISTEN: paseoListen,
      PASEO_ELECTRON_FLAGS: `--remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
      EXPO_DEV_URL: `http://localhost:${metroPort}`,
    }),
  });

  try {
    await waitFor("Electron CDP endpoint", async () => {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => null);
      return response?.ok ? true : null;
    });
  } catch (error) {
    await writeFile(path.join(OUTPUT_DIR, "electron-dev-start-failure.log"), logs.join(""), "utf8");
    throw error;
  }

  return { app, metroChild, cdpPort, metroPort, logs };
}

async function stopElectron(input: ElectronProcess): Promise<void> {
  await input.app.close().catch(() => undefined);
  if (input.metroChild.exitCode === null && input.metroChild.signalCode === null) {
    input.metroChild.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    input.metroChild.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await writeFile(path.join(OUTPUT_DIR, "electron-dev.log"), input.logs.join(""), "utf8");
  await execFileText("npm", ["--prefix", REPO_ROOT, "run", "cli", "--", "daemon", "stop"], {
    PASEO_HOME,
    PASEO_LISTEN: paseoListen,
  }).catch(async (error) => {
    await writeFile(path.join(OUTPUT_DIR, "daemon-stop-error.txt"), String(error), "utf8");
  });
}

async function readServerId(): Promise<string> {
  return (await readFile(path.join(PASEO_HOME, "server-id"), "utf8")).trim();
}

async function startIsolatedDaemon(): Promise<void> {
  await execFileText(
    "npm",
    [
      "--prefix",
      REPO_ROOT,
      "run",
      "cli",
      "--",
      "daemon",
      "start",
      "--listen",
      paseoListen,
      "--home",
      PASEO_HOME,
    ],
    { PASEO_HOME, PASEO_LISTEN: paseoListen },
  );
}

async function readDaemonListen(): Promise<string | null> {
  const output = await execFileText(
    "npm",
    ["--prefix", REPO_ROOT, "run", "cli", "--", "daemon", "status"],
    { PASEO_HOME, PASEO_LISTEN: paseoListen },
  );
  const match = output.match(/Listen\s+([^\s]+)/);
  return match?.[1] ?? null;
}

async function screenshot(page: Page, name: string): Promise<string> {
  const filePath = path.join(OUTPUT_DIR, name);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function readWebviewBodyText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const webview = document.querySelector("webview") as
      | (Element & { executeJavaScript?: (code: string) => Promise<unknown> })
      | null;
    return webview?.executeJavaScript
      ? String(await webview.executeJavaScript("document.body.innerText"))
      : "";
  });
}

async function snapshotPage(page: Page): Promise<PageSnapshot> {
  const evaluated = await page
    .evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body?.innerText ?? null,
    }))
    .catch(() => null);
  return {
    url: evaluated?.url ?? page.url(),
    title: evaluated?.title ?? (await page.title().catch(() => "")),
    bodyText: evaluated?.bodyText ?? null,
  };
}

function isAppRendererSnapshot(snapshot: PageSnapshot, metroPort: number): boolean {
  const appHosts = [`localhost:${metroPort}`, `127.0.0.1:${metroPort}`];
  return appHosts.some((host) => snapshot.url.includes(host));
}

async function collectPageSnapshots(electronApp: ElectronApplication): Promise<PageSnapshot[]> {
  return Promise.all(electronApp.windows().map((page) => snapshotPage(page)));
}

async function findAppRendererPage(
  electronApp: ElectronApplication,
  metroPort: number,
): Promise<Page> {
  return waitFor("Paseo app renderer page", async () => {
    for (const page of electronApp.windows()) {
      const snapshot = await snapshotPage(page);
      if (isAppRendererSnapshot(snapshot, metroPort)) {
        return page;
      }
    }
    return null;
  });
}

async function instrumentBridge(page: Page): Promise<void> {
  await page.evaluate(() => {
    const desktop = window.paseoDesktop;
    const bridge = desktop?.browser;
    const qa: NonNullable<Window["__paseoElectronFindQa"]> = {
      timestamps: { instrumentationAttached: Date.now() },
      bridgeAvailable: Boolean(bridge),
      findInPageType: typeof bridge?.findInPage,
      stopFindInPageType: typeof bridge?.stopFindInPage,
      onFoundInPageType: typeof bridge?.onFoundInPage,
      bridgeFindCalls: [],
      bridgeStopCalls: [],
      bridgeListenerRegistrations: [],
      bridgeFoundEvents: [],
    };
    window.__paseoElectronFindQa = qa;
    if (!bridge?.findInPage || !bridge.stopFindInPage || !bridge.onFoundInPage) {
      return;
    }

    const wrapped = bridge;
    const originalFindInPage = bridge.findInPage.bind(bridge);
    const originalStopFindInPage = bridge.stopFindInPage.bind(bridge);
    const originalOnFoundInPage = bridge.onFoundInPage.bind(bridge);

    wrapped.findInPage = (browserId, text, options) => {
      const entry: NonNullable<Window["__paseoElectronFindQa"]>["bridgeFindCalls"][number] = {
        browserId,
        text,
        options: { ...options },
        requestId: null,
        ts: Date.now(),
      };
      qa.timestamps.firstBridgeFindCall ??= entry.ts;
      qa.bridgeFindCalls.push(entry);
      const result = originalFindInPage(browserId, text, options);
      void Promise.resolve(result ?? null).then((requestId) => {
        entry.requestId = typeof requestId === "number" ? requestId : null;
        return undefined;
      });
      return result;
    };

    wrapped.stopFindInPage = (browserId, action) => {
      qa.bridgeStopCalls.push({ browserId, action, ts: Date.now() });
      return originalStopFindInPage(browserId, action);
    };

    wrapped.onFoundInPage = (browserId, listener) => {
      qa.bridgeListenerRegistrations.push({ browserId, ts: Date.now() });
      return originalOnFoundInPage(browserId, (result) => {
        qa.bridgeFoundEvents.push({ browserId, result, ts: Date.now() });
        listener(result);
      });
    };
    if (desktop) {
      try {
        Object.defineProperty(desktop, "browser", {
          configurable: true,
          enumerable: true,
          get: () => wrapped,
        });
      } catch {
        qa.timestamps.browserDescriptorWrapFailed = Date.now();
      }
    }
  });
}

async function installMainProcessInstrumentation(
  electronApp: ElectronApplication,
  fixtureOrigin: string,
): Promise<void> {
  await electronApp.evaluate(({ app, ipcMain, webContents }, qaOrigin) => {
    const globalScope = globalThis as typeof globalThis & {
      __paseoFindEvidence?: {
        installed: boolean;
        ipcHandleWraps: Array<{ channel: string; ok: boolean; reason?: string }>;
        ipcFindCalls: Array<{ args: unknown[]; ts: number; requestId: number | null }>;
        ipcStopCalls: Array<{ args: unknown[]; ts: number }>;
        guestFoundInPageEvents: Array<{ id: number; url: string; result: unknown; ts: number }>;
        ownerForwards: Array<{ id: number; channel: string; payload: unknown; ts: number }>;
        webContentsCreated: Array<{ id: number; type: string; url: string; ts: number }>;
      };
    };
    type MainFindEvidence = NonNullable<typeof globalScope.__paseoFindEvidence>;
    const evidence: MainFindEvidence = {
      installed: true,
      ipcHandleWraps: [],
      ipcFindCalls: [],
      ipcStopCalls: [],
      guestFoundInPageEvents: [],
      ownerForwards: [],
      webContentsCreated: [],
    };
    globalScope.__paseoFindEvidence = evidence;

    const invokeHandlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })
      ._invokeHandlers;
    const wrapInvoke = (channel: string) => {
      const original = invokeHandlers?.get(channel);
      if (typeof original !== "function") {
        evidence.ipcHandleWraps.push({ channel, ok: false, reason: "handler not found" });
        return;
      }
      invokeHandlers?.set(channel, (event: unknown, ...args: unknown[]) => {
        const ts = Date.now();
        const result = (original as (event: unknown, ...args: unknown[]) => unknown)(
          event,
          ...args,
        );
        if (channel === "paseo:browser:find-in-page") {
          const entry = { args, ts, requestId: null as number | null };
          evidence.ipcFindCalls.push(entry);
          void Promise.resolve(result).then((requestId) => {
            entry.requestId = typeof requestId === "number" ? requestId : null;
            return undefined;
          });
        } else {
          evidence.ipcStopCalls.push({
            args,
            ts,
          });
        }
        return result;
      });
      evidence.ipcHandleWraps.push({ channel, ok: true });
    };
    wrapInvoke("paseo:browser:find-in-page");
    wrapInvoke("paseo:browser:stop-find-in-page");

    const attachFoundListener = (contents: Electron.WebContents) => {
      if ((contents as unknown as { __paseoFindQaAttached?: boolean }).__paseoFindQaAttached) {
        return;
      }
      (contents as unknown as { __paseoFindQaAttached?: boolean }).__paseoFindQaAttached = true;
      evidence.webContentsCreated.push({
        id: contents.id,
        type: contents.getType(),
        url: contents.getURL(),
        ts: Date.now(),
      });
      contents.on("found-in-page", (_event, result) => {
        evidence.guestFoundInPageEvents.push({
          id: contents.id,
          url: contents.getURL(),
          result,
          ts: Date.now(),
        });
      });
      const originalSend = contents.send.bind(contents);
      contents.send = ((channel: string, ...args: unknown[]) => {
        if (channel === "paseo:event:browser-found-in-page") {
          evidence.ownerForwards.push({
            id: contents.id,
            channel,
            payload: args[0] ?? null,
            ts: Date.now(),
          });
        }
        return originalSend(channel, ...args);
      }) as typeof contents.send;
    };

    for (const contents of webContents.getAllWebContents()) {
      attachFoundListener(contents);
    }
    app.on("web-contents-created", (_event, contents) => {
      attachFoundListener(contents);
      contents.on("did-navigate", () => {
        if (contents.getURL().startsWith(qaOrigin)) {
          evidence.webContentsCreated.push({
            id: contents.id,
            type: contents.getType(),
            url: contents.getURL(),
            ts: Date.now(),
          });
        }
      });
    });
  }, fixtureOrigin);
}

async function readMainProcessEvidence(
  electronApp: ElectronApplication,
): Promise<QaEvidence["mainProcess"]> {
  return electronApp.evaluate(() => {
    const globalScope = globalThis as typeof globalThis & {
      __paseoFindEvidence?: QaEvidence["mainProcess"];
    };
    return globalScope.__paseoFindEvidence ?? null;
  });
}

interface DiagnosticExperimentEvidence {
  electronVersion: string;
  control: {
    target: { id: number; type: string; url: string } | null;
    requestId: number | null;
    events: Array<{ sourceId: number; type: string; url: string; result: unknown; ts: number }>;
  };
  guest: {
    target: { id: number; type: string; url: string } | null;
    requestId: number | null;
    contentsAtFind: Array<{ id: number; type: string; url: string }>;
    allEvents: Array<{ sourceId: number; type: string; url: string; result: unknown; ts: number }>;
  };
  conclusion: string;
}

// eslint-disable-next-line no-unused-vars
async function runDiagnosticExperiment(
  electronApp: ElectronApplication,
  fixtureOrigin: string,
): Promise<DiagnosticExperimentEvidence> {
  return electronApp.evaluate(async ({ webContents }, qaOrigin) => {
    interface ContentsSummary {
      id: number;
      type: string;
      url: string;
    }
    interface FindEvent extends ContentsSummary {
      sourceId: number;
      result: unknown;
      ts: number;
    }
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const summarize = (contents: Electron.WebContents): ContentsSummary => ({
      id: contents.id,
      type: contents.getType(),
      url: contents.getURL(),
    });
    const allContents = () =>
      webContents.getAllWebContents().filter((contents) => !contents.isDestroyed());
    const mainWindow =
      allContents().find((contents) => contents.getType() === "window") ?? allContents()[0] ?? null;
    const guest =
      allContents().find((contents) => contents.getURL().startsWith(qaOrigin)) ??
      allContents().find((contents) => contents.getType() === "webview") ??
      null;

    const controlEvents: FindEvent[] = [];
    const guestEvents: FindEvent[] = [];
    const addListener = (contents: Electron.WebContents, bucket: FindEvent[]) => {
      const listener = (_event: Electron.Event, result: Electron.Result) => {
        bucket.push({
          sourceId: contents.id,
          ...summarize(contents),
          result,
          ts: Date.now(),
        });
      };
      contents.on("found-in-page", listener);
      return () => contents.removeListener("found-in-page", listener);
    };

    let controlRequestId: number | null = null;
    const cleanupControl = mainWindow ? [addListener(mainWindow, controlEvents)] : [];
    if (mainWindow) {
      controlRequestId = mainWindow.findInPage("Workspace");
      await sleep(2000);
      mainWindow.stopFindInPage("clearSelection");
    }
    for (const cleanup of cleanupControl) cleanup();

    const contentsAtFind = allContents().map(summarize);
    const cleanupGuest = allContents().map((contents) => addListener(contents, guestEvents));
    let guestRequestId: number | null = null;
    if (guest) {
      guestRequestId = guest.findInPage("experiment_only_marker");
    }
    await sleep(2000);
    if (guest) {
      guest.stopFindInPage("clearSelection");
    }
    if (mainWindow) {
      mainWindow.stopFindInPage("clearSelection");
    }
    for (const cleanup of cleanupGuest) cleanup();

    let conclusion =
      "No WebContents delivered found-in-page for either the main-window control or guest find.";
    if (controlEvents.length > 0 && guestEvents.length > 0) {
      conclusion = "Both main-window and guest WebContents delivered found-in-page events.";
    } else if (controlEvents.length > 0) {
      conclusion =
        "Main-window find delivers found-in-page, but guest WebContents find does not deliver any found-in-page event.";
    } else if (guestEvents.length > 0) {
      conclusion =
        "Guest WebContents delivered found-in-page, but the main-window control did not.";
    }

    return {
      electronVersion: process.versions.electron,
      control: {
        target: mainWindow ? summarize(mainWindow) : null,
        requestId: controlRequestId,
        events: controlEvents,
      },
      guest: {
        target: guest ? summarize(guest) : null,
        requestId: guestRequestId,
        contentsAtFind,
        allEvents: guestEvents,
      },
      conclusion,
    };
  }, fixtureOrigin);
}

// eslint-disable-next-line no-unused-vars
async function writeDiagnosticExperiment(
  experiment: DiagnosticExperimentEvidence,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(OUTPUT_DIR, `diagnostic-experiment-${timestamp}.md`);
  const lines = [
    "# Electron FindInPage Diagnostic Experiment",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Electron version: ${experiment.electronVersion}`,
    "",
    "## A. Main Window Control",
    "",
    `- Target: ${JSON.stringify(experiment.control.target)}`,
    `- Request ID: ${experiment.control.requestId ?? "<missing>"}`,
    `- Events: ${JSON.stringify(experiment.control.events)}`,
    "",
    "## B. Guest WebContents Sweep",
    "",
    `- Guest target: ${JSON.stringify(experiment.guest.target)}`,
    `- Request ID: ${experiment.guest.requestId ?? "<missing>"}`,
    `- WebContents at find-call time: ${JSON.stringify(experiment.guest.contentsAtFind)}`,
    `- Events from any WebContents: ${JSON.stringify(experiment.guest.allEvents)}`,
    "",
    "## Conclusion",
    "",
    experiment.conclusion,
    "",
  ];
  await writeFile(filePath, lines.join("\n"), "utf8");
  await writeFile(
    path.join(OUTPUT_DIR, "diagnostic-experiment-evidence.json"),
    JSON.stringify(experiment, null, 2),
    "utf8",
  );
  return filePath;
}

interface DiagnosticFocusExperimentEvidence {
  electronVersion: string;
  visibleWebview: { id: number; type: string; url: string } | null;
  implLookup: {
    browserId: string | null;
    contentsId: number | null;
    error: string | null;
  };
  withoutFocus: {
    requestId: number | null;
    events: Array<{ sourceId: number; type: string; url: string; result: unknown; ts: number }>;
  };
  withGuestFocus: {
    requestId: number | null;
    events: Array<{ sourceId: number; type: string; url: string; result: unknown; ts: number }>;
  };
  conclusion: string;
}

// eslint-disable-next-line no-unused-vars
async function runDiagnosticFocusExperiment(
  electronApp: ElectronApplication,
  browserWebviewsModulePath: string,
): Promise<DiagnosticFocusExperimentEvidence> {
  // eslint-disable-next-line complexity
  return electronApp.evaluate(async ({ webContents }, modulePath) => {
    interface ContentsSummary {
      id: number;
      type: string;
      url: string;
    }
    interface FindEvent extends ContentsSummary {
      sourceId: number;
      result: unknown;
      ts: number;
    }
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const summarize = (contents: Electron.WebContents): ContentsSummary => ({
      id: contents.id,
      type: contents.getType(),
      url: contents.getURL(),
    });
    const liveContents = () =>
      webContents.getAllWebContents().filter((contents) => !contents.isDestroyed());
    const owner =
      liveContents().find((contents) => contents.getType() === "window") ??
      liveContents()[0] ??
      null;
    const guest =
      liveContents().find((contents) => contents.getType() === "webview") ??
      liveContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1:")) ??
      null;
    const addOwnerListener = (bucket: FindEvent[]) => {
      if (!owner) return () => undefined;
      const listener = (_event: Electron.Event, result: Electron.Result) => {
        bucket.push({
          sourceId: owner.id,
          ...summarize(owner),
          result,
          ts: Date.now(),
        });
      };
      owner.on("found-in-page", listener);
      return () => owner.removeListener("found-in-page", listener);
    };

    const implLookup: DiagnosticFocusExperimentEvidence["implLookup"] = {
      browserId: null,
      contentsId: null,
      error: null,
    };
    try {
      const nodeRequire = process.mainModule?.require.bind(process.mainModule);
      if (!nodeRequire) {
        throw new Error("process.mainModule.require is unavailable");
      }
      const browserWebviews = nodeRequire(modulePath) as {
        getPaseoBrowserIdForWebContents?: (contents: Electron.WebContents | null) => string | null;
        getPaseoBrowserWebContents?: (browserId: string) => Electron.WebContents | null;
      };
      implLookup.browserId =
        browserWebviews.getPaseoBrowserIdForWebContents?.(guest ?? null) ?? null;
      const implContents = implLookup.browserId
        ? browserWebviews.getPaseoBrowserWebContents?.(implLookup.browserId)
        : null;
      implLookup.contentsId = implContents?.id ?? null;
    } catch (error) {
      implLookup.error = error instanceof Error ? error.message : String(error);
    }

    const withoutFocusEvents: FindEvent[] = [];
    const cleanupWithoutFocus = addOwnerListener(withoutFocusEvents);
    const withoutFocusRequestId = guest?.findInPage("focus_test_a", { findNext: false }) ?? null;
    await sleep(1500);
    cleanupWithoutFocus();
    guest?.stopFindInPage("clearSelection");
    owner?.stopFindInPage("clearSelection");

    const withGuestFocusEvents: FindEvent[] = [];
    const cleanupWithGuestFocus = addOwnerListener(withGuestFocusEvents);
    guest?.focus();
    const withGuestFocusRequestId = guest?.findInPage("focus_test_b", { findNext: false }) ?? null;
    await sleep(1500);
    cleanupWithGuestFocus();
    guest?.stopFindInPage("clearSelection");
    owner?.stopFindInPage("clearSelection");

    let conclusion = "Neither blurred nor explicitly focused guest find delivered owner events.";
    if (withoutFocusEvents.length > 0 && withGuestFocusEvents.length > 0) {
      conclusion =
        "Focus is not required: both blurred and explicitly focused guest find delivered owner events.";
    } else if (withoutFocusEvents.length === 0 && withGuestFocusEvents.length > 0) {
      conclusion =
        "Guest focus is required: blurred guest find produced no owner events, focused guest find did.";
    } else if (withoutFocusEvents.length > 0) {
      conclusion = "Blurred guest find delivered owner events, but focused guest find did not.";
    }

    return {
      electronVersion: process.versions.electron,
      visibleWebview: guest ? summarize(guest) : null,
      implLookup,
      withoutFocus: {
        requestId: withoutFocusRequestId,
        events: withoutFocusEvents,
      },
      withGuestFocus: {
        requestId: withGuestFocusRequestId,
        events: withGuestFocusEvents,
      },
      conclusion,
    };
  }, browserWebviewsModulePath);
}

// eslint-disable-next-line no-unused-vars
async function writeDiagnosticFocusExperiment(
  experiment: DiagnosticFocusExperimentEvidence,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(OUTPUT_DIR, `diagnostic-focus-experiment-${timestamp}.md`);
  const lines = [
    "# Electron Find Focus Diagnostic Experiment",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Electron version: ${experiment.electronVersion}`,
    "",
    "## WebContents Identity",
    "",
    `- Visible webview: ${JSON.stringify(experiment.visibleWebview)}`,
    `- Impl lookup: ${JSON.stringify(experiment.implLookup)}`,
    "",
    "## A. Blurred Guest",
    "",
    `- Request ID: ${experiment.withoutFocus.requestId ?? "<missing>"}`,
    `- Events: ${JSON.stringify(experiment.withoutFocus.events)}`,
    `- Fired events: ${experiment.withoutFocus.events.length > 0}`,
    "",
    "## B. Explicit Guest Focus",
    "",
    `- Request ID: ${experiment.withGuestFocus.requestId ?? "<missing>"}`,
    `- Events: ${JSON.stringify(experiment.withGuestFocus.events)}`,
    `- Fired events: ${experiment.withGuestFocus.events.length > 0}`,
    "",
    "## Conclusion",
    "",
    experiment.conclusion,
    "",
  ];
  await writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

interface DiagnosticControlExperimentEvidence {
  electronVersion: string;
  contentsAtStart: Array<{
    id: number;
    type: string;
    url: string;
    isDestroyed: boolean;
    foundInPageListenerCount: number;
  }>;
  guest: { id: number; type: string; url: string } | null;
  owner: { id: number; type: string; url: string } | null;
  repeatUnique: {
    requestId: number | null;
    events: Array<{ sourceId: number; type: string; url: string; result: unknown; ts: number }>;
  };
  ownerControl: {
    requestId: number | null;
    events: Array<{ sourceId: number; type: string; url: string; result: unknown; ts: number }>;
  };
  afterReload: {
    requestId: number | null;
    didStopLoading: boolean;
    events: Array<{ sourceId: number; type: string; url: string; result: unknown; ts: number }>;
  };
  conclusion: string;
}

// eslint-disable-next-line no-unused-vars
async function runDiagnosticControlExperiment(
  electronApp: ElectronApplication,
  guestId: number | null,
): Promise<DiagnosticControlExperimentEvidence> {
  // eslint-disable-next-line complexity
  return electronApp.evaluate(async ({ webContents }, qaGuestId) => {
    interface ContentsSummary {
      id: number;
      type: string;
      url: string;
    }
    interface FindEvent extends ContentsSummary {
      sourceId: number;
      result: unknown;
      ts: number;
    }
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const liveContents = () =>
      webContents.getAllWebContents().filter((contents) => !contents.isDestroyed());
    const summarize = (contents: Electron.WebContents): ContentsSummary => ({
      id: contents.id,
      type: contents.getType(),
      url: contents.getURL(),
    });
    const contentsAtStart = liveContents().map((contents) => {
      const summary = summarize(contents);
      return {
        id: summary.id,
        type: summary.type,
        url: summary.url,
        isDestroyed: contents.isDestroyed(),
        foundInPageListenerCount: contents.listenerCount("found-in-page"),
      };
    });
    const owner =
      liveContents().find((contents) => contents.getType() === "window") ??
      liveContents()[0] ??
      null;
    const guestFromId = typeof qaGuestId === "number" ? webContents.fromId(qaGuestId) : null;
    const guest =
      guestFromId && !guestFromId.isDestroyed()
        ? guestFromId
        : (liveContents().find((contents) => contents.getType() === "webview") ?? null);

    const collectFind = async (
      target: Electron.WebContents | null,
      text: string,
      timeoutMs: number,
    ) => {
      const events: FindEvent[] = [];
      const cleanups = liveContents().map((contents) => {
        const listener = (_event: Electron.Event, result: Electron.Result) => {
          events.push({
            sourceId: contents.id,
            ...summarize(contents),
            result,
            ts: Date.now(),
          });
        };
        contents.on("found-in-page", listener);
        return () => contents.removeListener("found-in-page", listener);
      });
      const requestId = target?.findInPage(text, { findNext: false }) ?? null;
      await sleep(timeoutMs);
      for (const cleanup of cleanups) cleanup();
      target?.stopFindInPage("clearSelection");
      owner?.stopFindInPage("clearSelection");
      guest?.stopFindInPage("clearSelection");
      return { requestId, events };
    };

    const repeatUnique = await collectFind(guest, "control_repeat_unique", 2000);
    const ownerControl = await collectFind(owner, "Workspace", 2000);

    let didStopLoading = false;
    if (guest) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // eslint-disable-next-line promise/no-multiple-resolved
          resolve();
        };
        const timer = setTimeout(finish, 5000);
        const stopLoading = () => {
          didStopLoading = true;
          finish();
        };
        guest.once("did-stop-loading", stopLoading);
        guest.reload();
      });
    }
    const afterReload = await collectFind(guest, "control_after_reload", 2000);

    let conclusion = "Electron findInPage did not deliver events on guest or owner controls.";
    if (repeatUnique.events.length > 0) {
      conclusion = "Guest findInPage still delivers events at the failing moment.";
    } else if (ownerControl.events.length > 0 && afterReload.events.length > 0) {
      conclusion =
        "Top-level find works and reloading revives guest find delivery; the guest find path is stale before reload.";
    } else if (ownerControl.events.length > 0) {
      conclusion =
        "Top-level find works, but guest find delivery is broken at this point even after reload.";
    } else if (afterReload.events.length > 0) {
      conclusion = "Reload revives guest find delivery, but top-level owner control did not fire.";
    }

    return {
      electronVersion: process.versions.electron,
      contentsAtStart,
      guest: guest ? summarize(guest) : null,
      owner: owner ? summarize(owner) : null,
      repeatUnique,
      ownerControl,
      afterReload: {
        requestId: afterReload.requestId,
        didStopLoading,
        events: afterReload.events,
      },
      conclusion,
    };
  }, guestId);
}

// eslint-disable-next-line no-unused-vars
async function writeDiagnosticControlExperiment(
  experiment: DiagnosticControlExperimentEvidence,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(OUTPUT_DIR, `diagnostic-control-experiment-${timestamp}.md`);
  const lines = [
    "# Electron Find Control Diagnostic Experiment",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Electron version: ${experiment.electronVersion}`,
    "",
    "## WebContents",
    "",
    `- Contents at start: ${JSON.stringify(experiment.contentsAtStart)}`,
    `- Guest target: ${JSON.stringify(experiment.guest)}`,
    `- Owner target: ${JSON.stringify(experiment.owner)}`,
    "",
    "## A. Guest Repeat Unique",
    "",
    `- Request ID: ${experiment.repeatUnique.requestId ?? "<missing>"}`,
    `- Event count: ${experiment.repeatUnique.events.length}`,
    `- Events: ${JSON.stringify(experiment.repeatUnique.events)}`,
    "",
    "## B. Owner Control",
    "",
    `- Request ID: ${experiment.ownerControl.requestId ?? "<missing>"}`,
    `- Event count: ${experiment.ownerControl.events.length}`,
    `- Events: ${JSON.stringify(experiment.ownerControl.events)}`,
    "",
    "## C. Guest After Reload",
    "",
    `- did-stop-loading observed: ${experiment.afterReload.didStopLoading}`,
    `- Request ID: ${experiment.afterReload.requestId ?? "<missing>"}`,
    `- Event count: ${experiment.afterReload.events.length}`,
    `- Events: ${JSON.stringify(experiment.afterReload.events)}`,
    "",
    "## Conclusion",
    "",
    experiment.conclusion,
    "",
  ];
  await writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

// eslint-disable-next-line complexity
async function writeHarnessBlocker(input: {
  reason: string;
  diagnosticPath: string | null;
  experimentPath: string | null;
  evidence: QaEvidence | null;
}): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(OUTPUT_DIR, `harness-blocker-${timestamp}.md`);
  const lines = [
    "# Electron Find Harness Blocker",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Reason: ${input.reason}`,
    `Diagnostic: ${input.diagnosticPath ?? "<not written>"}`,
    `Diagnostic experiment: ${input.experimentPath ?? "<not written>"}`,
    "",
    "## Focus State",
    "",
    `- Selected page: ${JSON.stringify(input.evidence?.selectedPage ?? null)}`,
    `- Find bar text: ${JSON.stringify(input.evidence?.app.findBarText ?? null)}`,
    `- Input value: ${JSON.stringify(input.evidence?.app.findInputValue ?? null)}`,
    `- Counter text: ${JSON.stringify(input.evidence?.app.counterText ?? null)}`,
    `- Webview URL: ${JSON.stringify(input.evidence?.webview.url ?? null)}`,
    "",
    "## Main Process",
    "",
    `- Find IPC calls: ${JSON.stringify(input.evidence?.mainProcess?.ipcFindCalls ?? [])}`,
    `- Electron found-in-page events: ${JSON.stringify(
      input.evidence?.mainProcess?.guestFoundInPageEvents ?? [],
    )}`,
    `- Owner forwards: ${JSON.stringify(input.evidence?.mainProcess?.ownerForwards ?? [])}`,
    "",
  ];
  await writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

async function collectEvidence(
  page: Page,
  electronApp: ElectronApplication,
  processInfo: ElectronProcess,
  daemonListen: string | null,
  serverId: string | null,
): Promise<QaEvidence> {
  const pages = await collectPageSnapshots(electronApp);
  const mainProcess = await readMainProcessEvidence(electronApp).catch(() => null);
  const selectedPage = await snapshotPage(page);
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
    const bodyText = document.body.innerText;
    return {
      app: {
        url: location.href,
        title: document.title,
        bodyText,
        logboxCount: document.querySelectorAll("[data-testid='logbox_title']").length,
        findBarText: document.querySelector("[data-testid='pane-find-bar']")?.textContent ?? null,
        findInputValue: input?.value ?? null,
        counterText: bodyText.match(/\b\d+\s*\/\s*\d+\b/)?.[0] ?? null,
      },
      webview: {
        url: webview?.getURL?.() ?? null,
        text: webview?.executeJavaScript
          ? ((await webview.executeJavaScript("document.body.innerText")) as string)
          : null,
        webContentsId: webview?.getWebContentsId?.() ?? null,
        findInPageType: typeof webview?.findInPage,
        stopFindInPageType: typeof webview?.stopFindInPage,
      },
      qa: window.__paseoElectronFindQa ?? {
        timestamps: {},
        bridgeAvailable: false,
        findInPageType: null,
        stopFindInPageType: null,
        onFoundInPageType: null,
        bridgeFindCalls: [],
        bridgeStopCalls: [],
        bridgeListenerRegistrations: [],
        bridgeFoundEvents: [],
      },
    };
  });

  return {
    timestamps: runtime.qa.timestamps,
    pages,
    selectedPage,
    bridge: {
      available: runtime.qa.bridgeAvailable,
      findInPageType: runtime.qa.findInPageType,
      stopFindInPageType: runtime.qa.stopFindInPageType,
      onFoundInPageType: runtime.qa.onFoundInPageType,
      findCalls: runtime.qa.bridgeFindCalls,
      stopCalls: runtime.qa.bridgeStopCalls,
      listenerRegistrations: runtime.qa.bridgeListenerRegistrations,
      foundEvents: runtime.qa.bridgeFoundEvents,
    },
    mainProcess,
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
        "packages/app/src/components/browser-pane.electron.tsx:464-485 prefers getDesktopHost().browser.findInPage before falling back to webview.findInPage.",
        "packages/app/src/components/browser-pane.electron.tsx:681-701 subscribes through getDesktopHost().browser.onFoundInPage when the bridge exists.",
      ],
      preload: [
        "packages/desktop/src/preload.ts:68-96 exposes browser.findInPage, stopFindInPage, and onFoundInPage on window.paseoDesktop.browser.",
      ],
      main: [
        "packages/desktop/src/main.ts:223-242 handles paseo:browser:find-in-page by calling the guest WebContents findInPage.",
        "packages/desktop/src/main.ts:245-260 handles paseo:browser:stop-find-in-page.",
        "packages/desktop/src/main.ts:381-385 registers attached browser WebContents with the owner BrowserWindow WebContents.",
      ],
      browserWebviews: [
        "packages/desktop/src/features/browser-webviews.ts:20-34 forwards guest WebContents found-in-page results to the owner renderer.",
        "packages/desktop/src/features/browser-webviews.ts:59-66 resolves WebContents by browserId for main-process find.",
      ],
      electronDocs: [
        "https://www.electronjs.org/docs/latest/api/web-contents#event-found-in-page documents main-process webContents found-in-page for contents.findInPage.",
      ],
    },
    hypothesis:
      "The main-process bridge should make renderer webview found-in-page delivery irrelevant; failure now means the app renderer did not receive or consume bridge results.",
    cheapestFixShape:
      "Keep the app renderer as the only Playwright control target, assert the shared FindBar counter, and use window.paseoDesktop.browser instrumentation only as diagnostic evidence around bridge calls and result callbacks.",
  };
}

async function writeEvidence(evidence: QaEvidence): Promise<void> {
  await writeFile(
    path.join(OUTPUT_DIR, "electron-find-evidence.json"),
    JSON.stringify(evidence, null, 2),
    "utf8",
  );
}

// eslint-disable-next-line complexity
async function writeDiagnostic(evidence: QaEvidence): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(OUTPUT_DIR, `diagnostic-${timestamp}.md`);
  const pageLines = evidence.pages.map(
    (page, index) =>
      `- page ${index + 1}: title=${JSON.stringify(page.title)} url=${JSON.stringify(page.url)}`,
  );
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
    `- Selected renderer title: ${JSON.stringify(evidence.selectedPage.title)}`,
    `- Selected renderer URL: ${evidence.selectedPage.url}`,
    `- Webview URL: ${evidence.webview.url ?? "<missing>"}`,
    "",
    "## Pages",
    "",
    ...pageLines,
    "",
    "## Findings",
    "",
    `- selected app renderer: ${isAppRendererSnapshot(evidence.selectedPage, evidence.process.metroPort)}`,
    `- app body starts with guest page only: ${evidence.app.bodyText.trim() === "Find QA Page"}`,
    `- bridge available: ${evidence.bridge.available}`,
    `- bridge findInPage typeof: ${evidence.bridge.findInPageType}`,
    `- bridge stopFindInPage typeof: ${evidence.bridge.stopFindInPageType}`,
    `- bridge onFoundInPage typeof: ${evidence.bridge.onFoundInPageType}`,
    `- first bridge find timestamp: ${evidence.timestamps.firstBridgeFindCall ?? "<missing>"}`,
    `- bridge listener registrations: ${JSON.stringify(evidence.bridge.listenerRegistrations)}`,
    `- bridge findInPage calls: ${JSON.stringify(evidence.bridge.findCalls)}`,
    `- bridge found-in-page events observed in app renderer: ${JSON.stringify(evidence.bridge.foundEvents)}`,
    `- bridge stopFindInPage calls: ${JSON.stringify(evidence.bridge.stopCalls)}`,
    `- main-process instrumentation installed: ${evidence.mainProcess?.installed ?? false}`,
    `- main-process ipc handler wraps: ${JSON.stringify(evidence.mainProcess?.ipcHandleWraps ?? [])}`,
    `- main-process find IPC calls: ${JSON.stringify(evidence.mainProcess?.ipcFindCalls ?? [])}`,
    `- main-process stop IPC calls: ${JSON.stringify(evidence.mainProcess?.ipcStopCalls ?? [])}`,
    `- main-process Electron found-in-page events: ${JSON.stringify(
      evidence.mainProcess?.guestFoundInPageEvents ?? [],
    )}`,
    `- main-process owner forwards: ${JSON.stringify(evidence.mainProcess?.ownerForwards ?? [])}`,
    `- main-process webContents observed: ${JSON.stringify(
      evidence.mainProcess?.webContentsCreated ?? [],
    )}`,
    `- webview.getWebContentsId(): ${evidence.webview.webContentsId ?? "<missing>"}`,
    `- webview text matches fixture: ${evidence.webview.text === QA_PAGE_TEXT}`,
    `- UI find bar text: ${JSON.stringify(evidence.app.findBarText)}`,
    `- UI input value: ${JSON.stringify(evidence.app.findInputValue)}`,
    `- UI counter text: ${JSON.stringify(evidence.app.counterText)}`,
    `- LogBox count: ${evidence.app.logboxCount}`,
    "",
    "## Event Pattern",
    "",
    "- This harness drives only the Paseo app renderer page. Guest `<webview>` pages are listed as evidence but are not used for keyboard, screenshot, evaluate, or assertions.",
    "- The current implementation uses the main-process bridge: the renderer calls `window.paseoDesktop.browser.findInPage`, main calls `WebContents.findInPage`, main receives `webContents.on('found-in-page')`, then preload forwards the result to the app renderer.",
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
  // eslint-disable-next-line complexity
  test("forwards Cmd+F find through the Electron app renderer bridge", async () => {
    test.setTimeout(150_000);

    let staticServer: Server | null = null;
    let electron: ElectronProcess | null = null;
    let appPage: Page | null = null;
    let workspaceClient: WorkspaceSetupClient | null = null;
    let repo: TempRepo | null = null;
    let evidence: QaEvidence | null = null;
    let diagnosticPath: string | null = null;
    let experimentPath: string | null = null;
    let focusExperimentPath: string | null = null;
    let controlExperimentPath: string | null = null;

    try {
      const staticSite = await startStaticServer();
      staticServer = staticSite.server;
      paseoListen = `127.0.0.1:${await freePort()}`;
      await startIsolatedDaemon();
      electron = await startElectron();
      const serverId = await readServerId();
      const daemonListen = await waitFor("isolated desktop daemon", readDaemonListen, 45_000);
      if (daemonListen === "127.0.0.1:6767" || daemonListen === "localhost:6767") {
        throw new Error("Refusing to run Electron find QA against port 6767.");
      }
      const daemonPort = daemonListen.split(":").at(-1);
      if (!daemonPort) {
        throw new Error(`Could not parse daemon port from ${daemonListen}`);
      }
      process.env.E2E_DAEMON_PORT = daemonPort;
      process.env.E2E_SERVER_ID = serverId;
      workspaceClient = await connectWorkspaceSetupClient();
      repo = await createTempGitRepo("electron-find-pane-", {
        files: [{ path: "README.find.md", content: "electron find pane bootstrap\n" }],
      });
      const workspaceResult = await workspaceClient.openProject(repo.path);
      if (!workspaceResult.workspace) {
        throw new Error(workspaceResult.error ?? `Failed to open project ${repo.path}`);
      }

      appPage = await findAppRendererPage(electron.app, electron.metroPort);

      const workspaceRoute = `http://localhost:${electron.metroPort}/h/${serverId}/workspace/${encodeWorkspaceId(
        workspaceResult.workspace.id,
      )}`;
      await appPage.goto(workspaceRoute);
      appPage = await findAppRendererPage(electron.app, electron.metroPort);
      await appPage
        .getByTestId("workspace-new-browser")
        .waitFor({ state: "visible", timeout: 30_000 });
      await screenshot(appPage, "electron-find-01-workspace.png");

      await instrumentBridge(appPage);
      await appPage.getByTestId("workspace-new-browser").click();
      const webviewLocator = appPage.locator("webview").first();
      await webviewLocator.waitFor({ state: "attached", timeout: 15_000 });
      await appPage.waitForTimeout(1_000);
      await screenshot(appPage, "electron-find-02-browser-opened.png");
      await expect(appPage.getByTestId("logbox_title")).toHaveCount(0);

      const urlInput = appPage.getByRole("textbox", { name: "Browser URL" });
      await urlInput.fill(`http://127.0.0.1:${staticSite.port}/index.html`);
      await urlInput.press("Enter");
      await appPage.waitForFunction(
        (port) => {
          const webview = document.querySelector("webview") as
            | (Element & { getURL?: () => string })
            | null;
          return webview?.getURL?.().includes(`127.0.0.1:${port}`);
        },
        staticSite.port,
        { timeout: 15_000 },
      );
      const loadedAppPage = appPage;
      await expect
        .poll(() => readWebviewBodyText(loadedAppPage), { timeout: 10_000 })
        .toContain("electronneedle");
      await screenshot(appPage, "electron-find-03-page-loaded.png");
      await installMainProcessInstrumentation(electron.app, `http://127.0.0.1:${staticSite.port}`);
      await instrumentBridge(appPage);

      const selectedPageBeforeFind = await snapshotPage(appPage);
      if (!isAppRendererSnapshot(selectedPageBeforeFind, electron.metroPort)) {
        throw new Error(
          `Refusing to dispatch keyboard to non-app page: ${selectedPageBeforeFind.title} ${selectedPageBeforeFind.url}`,
        );
      }

      const box = await webviewLocator.boundingBox();
      if (!box) throw new Error("webview has no bounding box");
      await appPage.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        window.focus();
      });
      await appPage.mouse.click(box.x + Math.min(160, box.width / 2), Math.max(24, box.y - 110));
      await appPage.waitForTimeout(250);
      const activeElementBeforeShortcut = await appPage.evaluate(() => ({
        tagName: document.activeElement?.tagName ?? null,
        testId: document.activeElement?.getAttribute("data-testid") ?? null,
        ariaLabel: document.activeElement?.getAttribute("aria-label") ?? null,
      }));
      if (activeElementBeforeShortcut.tagName === "WEBVIEW") {
        throw new Error(
          `Host focus failed before Cmd+F: ${JSON.stringify(activeElementBeforeShortcut)}`,
        );
      }
      await screenshot(appPage, "electron-find-04-before-keypress.png");
      const syntheticOpenResult = await appPage.evaluate(() => {
        const event = new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          metaKey: navigator.platform.toLowerCase().includes("mac"),
          ctrlKey: !navigator.platform.toLowerCase().includes("mac"),
          bubbles: true,
          cancelable: true,
        });
        return window.dispatchEvent(event);
      });
      await appPage.getByTestId("pane-find-bar").waitFor({ state: "visible", timeout: 10_000 });
      await appPage.evaluate((value) => {
        const input = document.querySelector(
          "[data-testid='pane-find-input']",
        ) as HTMLInputElement | null;
        if (!input) {
          throw new Error("pane-find-input not found");
        }
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, value);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, "electronneedle");
      await appPage.evaluate((opened) => {
        window.__paseoElectronFindQa = window.__paseoElectronFindQa ?? {
          timestamps: {},
          bridgeAvailable: false,
          findInPageType: null,
          stopFindInPageType: null,
          onFoundInPageType: null,
          bridgeFindCalls: [],
          bridgeStopCalls: [],
          bridgeListenerRegistrations: [],
          bridgeFoundEvents: [],
        };
        window.__paseoElectronFindQa.timestamps.syntheticOpenDispatchReturned = opened ? 1 : 0;
      }, syntheticOpenResult);
      await expect(appPage.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await screenshot(appPage, "electron-find-04-query.png");

      await appPage.getByTestId("pane-find-next").click();
      await expect(appPage.getByText("2 / 3")).toBeVisible({ timeout: 10_000 });
      await appPage.getByTestId("pane-find-prev").click();
      await expect(appPage.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await appPage.getByTestId("pane-find-close").click();
      await expect(appPage.getByTestId("pane-find-bar")).toHaveCount(0);

      evidence = await collectEvidence(appPage, electron.app, electron, daemonListen, serverId);
      await writeEvidence(evidence);
      diagnosticPath = await writeDiagnostic(evidence);
      await screenshot(appPage, "electron-find-05-closed.png");
      expect(evidence.bridge.foundEvents.length).toBeGreaterThan(0);
      expect(evidence.mainProcess?.ipcFindCalls.length ?? 0).toBeGreaterThan(0);
      expect(evidence.mainProcess?.ownerForwards.length ?? 0).toBeGreaterThan(0);
    } catch (error) {
      if (electron) {
        appPage =
          appPage ??
          (await findAppRendererPage(electron.app, electron.metroPort).catch(() => null));
        if (appPage) {
          const daemonListen = await readDaemonListen().catch(() => null);
          const serverId = await readServerId().catch(() => null);
          await screenshot(appPage, "electron-find-failure-state.png").catch(() => undefined);
          evidence = await collectEvidence(appPage, electron.app, electron, daemonListen, serverId);
          await writeEvidence(evidence);
          diagnosticPath = await writeDiagnostic(evidence);
          if (
            error instanceof Error &&
            (error.message.includes("pane-find-bar") ||
              error.message.includes("getByText('1 / 3')"))
          ) {
            await writeHarnessBlocker({
              reason: error.message,
              diagnosticPath,
              experimentPath,
              evidence,
            });
          }
        }
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nDiagnostic: ${
          diagnosticPath ?? "<not written>"
        }\nDiagnostic experiment: ${experimentPath ?? "<not written>"}\nFocus experiment: ${
          focusExperimentPath ?? "<not written>"
        }\nControl experiment: ${controlExperimentPath ?? "<not written>"}`,
        { cause: error },
      );
    } finally {
      await workspaceClient?.close().catch(() => undefined);
      await repo?.cleanup().catch(() => undefined);
      if (electron) await stopElectron(electron);
      if (staticServer) await stopServer(staticServer);
    }

    expect(evidence?.selectedPage.title).not.toBe("Find QA Page");
    expect(evidence?.webview.text).toBe(QA_PAGE_TEXT);
    expect(evidence?.bridge.foundEvents.length).toBeGreaterThan(0);
  });
});

declare global {
  interface Window {
    __paseoElectronFindQa?: {
      timestamps: Record<string, number>;
      bridgeAvailable: boolean;
      findInPageType: string | null;
      stopFindInPageType: string | null;
      onFoundInPageType: string | null;
      bridgeFindCalls: Array<{
        browserId: string;
        text: string;
        options: Record<string, unknown>;
        requestId: number | null;
        ts: number;
      }>;
      bridgeStopCalls: Array<{ browserId: string; action: string; ts: number }>;
      bridgeListenerRegistrations: Array<{ browserId: string; ts: number }>;
      bridgeFoundEvents: Array<{ browserId: string; result: unknown; ts: number }>;
    };
  }
}
