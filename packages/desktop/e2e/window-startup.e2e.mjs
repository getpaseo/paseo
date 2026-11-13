import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect } from "playwright/test";

const root = await mkdtemp(path.join(tmpdir(), "paseo-window-startup-"));
const modulePath = fileURLToPath(new URL("../dist/window/show-when-ready.js", import.meta.url));
const automationPath = fileURLToPath(
  new URL("../dist/features/browser-automation/", import.meta.url),
);

async function launchWindowWithoutHiddenFrames() {
  const main = path.join(root, "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require("electron");
     const { showWindowWhenReady } = require(${JSON.stringify(modulePath)});
     app.setPath("userData", ${JSON.stringify(path.join(root, "user-data"))});
     app.whenReady().then(async () => {
       const win = global.mainWindow = new BrowserWindow({ show: false, paintWhenInitiallyHidden: false });
       showWindowWhenReady(win, { showOnLoad: true });
       await win.loadURL("data:text/html,<h1>Desktop ready</h1>");
       global.visibleAfterLoad = win.isVisible();
     });`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
  );
  const displayArgs = process.platform === "linux" ? ["--ozone-platform=x11", "--disable-gpu"] : [];
  return electron.launch({
    args: ["--no-sandbox", ...displayArgs, main],
    env,
  });
}

async function expectLoadedDesktopIsShown(desktop) {
  await expect.poll(() => desktop.evaluate(() => global.visibleAfterLoad)).toBe(true);
  const page = await desktop.firstWindow();
  await expect(page.getByRole("heading", { name: "Desktop ready" })).toBeVisible();
}

async function launchBackgroundBrowser() {
  const fixture = path.join(root, "background.html");
  await writeFile(
    fixture,
    '<!doctype html><style>html{scrollbar-width:none}body{margin:0;width:2400px;height:2400px;background:rgb(0,200,0)}</style><h1>Background page</h1><div id="scroll-target" style="position:absolute;left:320px;top:1200px;width:1280px;height:800px"></div>',
  );
  const main = path.join(root, "background.cjs");
  await writeFile(
    main,
    `
    const { app, BrowserWindow, nativeImage } = require("electron");
    const { adaptWebContents } = require(${JSON.stringify(path.join(automationPath, "ipc.js"))});
    const { executeAutomationCommand } = require(${JSON.stringify(path.join(automationPath, "service.js"))});
    app.setPath("userData", ${JSON.stringify(path.join(root, "background-profile"))});
    app.whenReady().then(async () => {
      const win = global.backgroundWindow = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
      const attached = new Promise(resolve => win.webContents.once("did-attach-webview", (_event, guest) => resolve(guest)));
      await win.loadURL("data:text/html," + encodeURIComponent(
        '<div style="position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none">' +
        '<webview style="display:inline-flex;position:absolute;left:0;top:0;width:1280px;height:800px" src="' +
        ${JSON.stringify(pathToFileURL(fixture).href)} + '"></webview></div>'
      ));
      const guest = await attached;
      if (guest.isLoading()) await new Promise(resolve => guest.once("did-finish-load", resolve));
      const tab = adaptWebContents(guest);
      const registry = {
        getTabContents: () => tab,
        listRegisteredBrowserIds: () => ["background"],
        listRegisteredBrowserIdsForWorkspace: () => ["background"],
        getBrowserWorkspaceId: () => "workspace",
        getWorkspaceActiveBrowserId: () => "background",
      };
      const run = command => executeAutomationCommand({
        type: "browser.automation.execute.request", requestId: "background", workspaceId: "workspace", command,
      }, registry);
      global.captureBackground = async color => {
        if (color[0] > 0) await tab.sendDebugCommand("Emulation.setDeviceMetricsOverride", {
          width: 800, height: 600, deviceScaleFactor: 1, mobile: false,
        });
        const evaluated = await run({ command: "evaluate", args: {
          browserId: "background",
          function: '() => new Promise(resolve => { const timeout = setTimeout(() => resolve("animation frame stalled"), 2500); requestAnimationFrame(() => { clearTimeout(timeout); document.body.style.background = ' +
            JSON.stringify('rgb(' + color.join(',') + ')') + '; if (' + color[0] + ' > 0) { document.querySelector("#scroll-target").style.background = document.body.style.background; document.body.style.background = "black"; } scrollTo(' + (color[0] ? 320 : 0) + ',' + (color[0] ? 1200 : 0) + '); resolve(document.querySelector("h1").textContent); }); })',
        }});
        const screenshot = await run({ command: "screenshot", args: { browserId: "background", fullPage: false } });
        if (!evaluated.ok || !screenshot.ok) return { evaluated, screenshot };
        const image = nativeImage.createFromBuffer(Buffer.from(screenshot.result.dataBase64, "base64"));
        const size = image.getSize();
        const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
        const pixels = image.toBitmap();
        return {
          text: JSON.parse(evaluated.result.resultJson),
          pixel: [pixels[offset + 2], pixels[offset + 1], pixels[offset]],
          width: size.width,
          height: size.height,
          visible: win.isVisible(),
          throttled: guest.getBackgroundThrottling(),
        };
      };
      global.backgroundReady = true;
    });
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
  );
  const displayArgs =
    process.platform === "linux" && process.env.DISPLAY ? ["--ozone-platform=x11"] : [];
  return electron.launch({ args: ["--no-sandbox", ...displayArgs, main], env });
}

async function expectBackgroundBrowserWorks(desktop) {
  await expect.poll(() => desktop.evaluate(() => global.backgroundReady)).toBe(true);
  for (const color of [
    [0, 200, 0],
    [0, 0, 200],
    [200, 0, 0],
  ]) {
    const result = await desktop.evaluate(
      (_electron, requestedColor) => global.captureBackground(requestedColor),
      color,
    );
    expect(result).toEqual({
      text: "Background page",
      pixel: color,
      width: color[0] > 0 ? 800 : 1280,
      height: color[0] > 0 ? 600 : 800,
      visible: false,
      throttled: true,
    });
  }
}

let desktop;
try {
  desktop = await launchWindowWithoutHiddenFrames();
  await expectLoadedDesktopIsShown(desktop);
  console.log("Loaded desktop is visible without hidden compositor frames");
  await desktop.close();
  desktop = await launchBackgroundBrowser();
  await expectBackgroundBrowserWorks(desktop);
  console.log("Never-shown browser runs animation callbacks and captures fresh pixels repeatedly");
} finally {
  await desktop?.close();
  await rm(root, { recursive: true, force: true });
}
