import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect } from "playwright/test";

const root = await mkdtemp(path.join(tmpdir(), "paseo-window-startup-"));
const modulePath = fileURLToPath(new URL("../dist/window/show-when-ready.js", import.meta.url));
const inputMethodPath = fileURLToPath(
  new URL("../dist/features/linux-input-method.js", import.meta.url),
);

function portalIsRunning() {
  const result = spawnSync(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      "org.freedesktop.portal.IBus",
    ],
    { encoding: "utf8", timeout: 1_000 },
  );
  return result.status === 0 && result.stdout.trim() === "(true,)";
}

function pressNativeKey() {
  execFileSync("python3", [
    "-c",
    `
import ctypes
x = ctypes.CDLL('libX11.so.6')
t = ctypes.CDLL('libXtst.so.6')
p = ctypes.c_void_p
x.XOpenDisplay.restype = p
d = x.XOpenDisplay(None)
x.XKeysymToKeycode.argtypes = [p, ctypes.c_ulong]
x.XKeysymToKeycode.restype = ctypes.c_uint
key = x.XKeysymToKeycode(d, ord('a'))
t.XTestFakeKeyEvent.argtypes = [p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
t.XTestFakeKeyEvent(d, key, 1, 0)
t.XTestFakeKeyEvent(d, key, 0, 0)
x.XSync.argtypes = [p, ctypes.c_int]
x.XSync(d, 0)
x.XCloseDisplay.argtypes = [p]
x.XCloseDisplay(d)
`,
  ]);
}

async function expectInputMethodRecovers() {
  let daemon;
  let desktop;
  const socketPath = process.env.IBUS_ADDRESS.slice("unix:path=".length);
  async function startDaemon() {
    daemon = spawn(
      "ibus-daemon",
      [
        "--single",
        "--emoji-extension",
        "disable",
        "--panel",
        "disable",
        "--config",
        "disable",
        "--address",
        process.env.IBUS_ADDRESS,
      ],
      { stdio: "ignore" },
    );
    await expect.poll(() => existsSync(socketPath)).toBe(true);
    await expect.poll(portalIsRunning).toBe(true);
  }
  try {
    await startDaemon();
    const main = path.join(root, "input-method.cjs");
    await writeFile(
      main,
      `
      const { app, BrowserWindow } = require("electron");
      const { configureLinuxInputMethod } = require(${JSON.stringify(inputMethodPath)});
      configureLinuxInputMethod();
      app.setPath("userData", ${JSON.stringify(path.join(root, "input-profile"))});
      app.whenReady().then(async () => {
        global.win = new BrowserWindow({ width: 800, height: 600 });
        await win.loadURL('data:text/html,<input autofocus>');
        win.focus();
      });
    `,
    );
    const launchDesktop = () =>
      electron.launch({
        args: ["--no-sandbox", "--ozone-platform=x11", "--disable-gpu", main],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
        ),
      });
    desktop = await launchDesktop();
    const page = await desktop.firstWindow();
    await page.locator("input").focus();
    pressNativeKey();
    await expect(page.locator("input")).toHaveValue("a");

    await unlink(socketPath);
    await desktop.close();
    desktop = await launchDesktop();
    const second = await desktop.firstWindow();
    await second.locator("input").focus();
    pressNativeKey();
    await expect(second.locator("input")).toHaveValue("a");

    const stopped = once(daemon, "exit");
    daemon.kill();
    await stopped;
    await startDaemon();
    await expect(async () => {
      await second.locator("input").fill("");
      await second.locator("input").focus();
      pressNativeKey();
      await expect(second.locator("input")).toHaveValue("a", { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    expect(desktop.windows()).toHaveLength(1);
    console.log(
      "New Desktop process accepts native input after socket loss and reconnects after IBus restart without reloading",
    );
  } finally {
    await desktop?.close();
    daemon?.kill();
  }
}

async function runIsolatedInputMethodSession() {
  const sessionRoot = path.join(root, "input-session");
  for (const name of ["config", "cache", "data", "runtime"]) {
    await mkdir(path.join(sessionRoot, name), { recursive: true, mode: 0o700 });
  }
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(sessionRoot, "config"),
    XDG_CACHE_HOME: path.join(sessionRoot, "cache"),
    XDG_DATA_HOME: path.join(sessionRoot, "data"),
    XDG_RUNTIME_DIR: path.join(sessionRoot, "runtime"),
    XDG_CURRENT_DESKTOP: "",
    IBUS_ADDRESS: `unix:path=${path.join(sessionRoot, "ibus.sock")}`,
    GDK_BACKEND: "x11",
    GTK_IM_MODULE: "ibus",
    XMODIFIERS: "@im=ibus",
  };
  for (const key of [
    "DBUS_SESSION_BUS_ADDRESS",
    "DBUS_STARTER_ADDRESS",
    "DBUS_STARTER_BUS_TYPE",
    "WAYLAND_DISPLAY",
    "IBUS_USE_PORTAL",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    delete env[key];
  }
  const { stdout } = await promisify(execFile)(
    "dbus-run-session",
    ["--", process.execPath, fileURLToPath(import.meta.url), "--ibus-session"],
    { env, timeout: 45_000, maxBuffer: 1024 * 1024 },
  );
  console.log(stdout.trim());
}

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
  if (process.argv.includes("--ibus-session")) {
    await expectInputMethodRecovers();
  } else {
    desktop = await launchWindowWithoutHiddenFrames();
    await expectLoadedDesktopIsShown(desktop);
    console.log("Loaded desktop is visible without hidden compositor frames");
    await desktop.close();
    desktop = undefined;
    if (process.platform === "linux") await runIsolatedInputMethodSession();
  }
} finally {
  await desktop?.close();
  await rm(root, { recursive: true, force: true });
}
