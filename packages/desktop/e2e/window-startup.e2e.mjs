import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";

const root = await mkdtemp(path.join(tmpdir(), "paseo-window-startup-"));
const showWhenReadyPath = fileURLToPath(
  new URL("../dist/window/show-when-ready.js", import.meta.url),
);
const rendererRecoveryPath = fileURLToPath(
  new URL("../dist/window/renderer-recovery.js", import.meta.url),
);

async function launchDesktopWindow() {
  const main = path.join(root, "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require("electron");
     const { showWindowWhenReady } = require(${JSON.stringify(showWhenReadyPath)});
     const { reloadWhenRendererExits } = require(${JSON.stringify(rendererRecoveryPath)});
     app.setPath("userData", ${JSON.stringify(path.join(root, "user-data"))});
     app.whenReady().then(async () => {
       const win = global.mainWindow = new BrowserWindow({ show: false, paintWhenInitiallyHidden: false });
       showWindowWhenReady(win, { showOnLoad: true });
       reloadWhenRendererExits(win);
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

function rendererPid(desktop) {
  return desktop.evaluate(() => global.mainWindow.webContents.getOSProcessId());
}

async function expectDesktopReloadsAfterRendererIsTerminated(desktop) {
  const terminated = await rendererPid(desktop);
  process.kill(terminated, "SIGTERM");
  await expect.poll(() => rendererPid(desktop), { timeout: 15_000 }).not.toBe(terminated);
  await expect
    .poll(
      () =>
        desktop.evaluate(() =>
          global.mainWindow.webContents.executeJavaScript("document.body.textContent"),
        ),
      { timeout: 15_000 },
    )
    .toBe("Desktop ready");
}

let desktop;
try {
  desktop = await launchDesktopWindow();
  await expectLoadedDesktopIsShown(desktop);
  console.log("Loaded desktop is visible without hidden compositor frames");
  await expectDesktopReloadsAfterRendererIsTerminated(desktop);
  console.log("Desktop reloads its window after the renderer is terminated");
} finally {
  await desktop?.close();
  await rm(root, { recursive: true, force: true });
}
