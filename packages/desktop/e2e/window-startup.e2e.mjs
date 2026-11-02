import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";

const root = await mkdtemp(path.join(tmpdir(), "paseo-window-startup-"));
const modulePath = fileURLToPath(new URL("../dist/window/show-when-ready.js", import.meta.url));

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

let desktop;
try {
  desktop = await launchWindowWithoutHiddenFrames();
  await expectLoadedDesktopIsShown(desktop);
  console.log("Loaded desktop is visible without hidden compositor frames");
} finally {
  await desktop?.close();
  await rm(root, { recursive: true, force: true });
}
