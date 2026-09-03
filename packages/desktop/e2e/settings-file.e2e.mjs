#!/usr/bin/env node
/**
 * Real-Electron regression for the writable client settings file.
 *
 * Unit tests cover the file store and the renderer base store against fakes. Only a real Electron
 * run proves the two halves meet: that Metro resolves `settings-base-storage.electron.ts`, that the
 * IPC pair is registered, and that a hand-edited `settings.json` beats the localStorage values it
 * replaced. Everything here is invisible to vitest.
 *
 * Not wired into the per-PR checks — it boots a daemon, Metro and Electron, and takes a few
 * minutes. Run it by hand when touching the settings layering.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const devRunner = path.join(desktopDir, "scripts", "dev-runner.mjs");
const timeoutMs = 180_000;

/** Seed field names from packages/app/src/storage/settings-seed/registry.ts. */
const REGISTERED_FIELDS = new Set([
  "appSettings",
  "keyboardShortcutOverrides",
  "preferredEditor",
  "changesPreferences",
  "createAgentPreferences",
]);

const evidence = [];

function record(step, detail) {
  evidence.push({ step, detail });
  console.log(`\n===== ${step} =====`);
  console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
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

async function canConnect(port) {
  return await new Promise((resolve) => {
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
}

async function waitForPort(port, label, processInfo) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processInfo && (processInfo.child.exitCode !== null || processInfo.child.signalCode)) {
      throw new Error(`${label} exited before opening its port; see ${processInfo.logPath}`);
    }
    if (await canConnect(port)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} on port ${port}`);
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

async function waitForBridge(page) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await page.evaluate(() => typeof window.paseoDesktop?.invoke === "function");
      if (ready) return;
    } catch {
      // Metro replaces the renderer execution context during its initial load.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the Electron desktop bridge");
}

function settingsFilePath(userData) {
  return path.join(userData, "settings.json");
}

function readSettings(userData) {
  const file = settingsFilePath(userData);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function waitForSettings(userData, predicate, label) {
  const deadline = Date.now() + 60_000;
  let last = null;
  while (Date.now() < deadline) {
    last = readSettings(userData);
    if (last && predicate(last)) return last;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}. Last contents: ${JSON.stringify(last)}`);
}

/** The renderer reads the file once per page load, so every file assertion needs a reload. */
async function reloadApp(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForBridge(page);
  await delay(3_000);
}

async function openAppearanceSettings(page) {
  // Navigate through the real controls; a deep link bounces to the startup route.
  const settingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
  await settingsButton.waitFor({ state: "visible", timeout: 60_000 });
  await settingsButton.click();
  await page.waitForURL(/\/settings\/general$/, { timeout: 30_000 });
  await page.getByText("Appearance", { exact: true }).first().click();
  await delay(2_500);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runRegression({ page, userData, seedPath, artifactDir }) {
  // (1) A fresh profile gets a file, written by the main process at mode 0600.
  const fresh = await waitForSettings(
    userData,
    (doc) => doc.version === 1 && typeof doc.app === "object",
    "settings.json on a fresh profile",
  );
  record("1. Fresh profile creates settings.json", {
    path: settingsFilePath(userData),
    mode: (fs.statSync(settingsFilePath(userData)).mode & 0o777).toString(8),
    contents: fresh,
  });
  assert(fresh.version === 1, "the fresh document is version 1");
  assert(
    (fs.statSync(settingsFilePath(userData)).mode & 0o777) === 0o600,
    "the file is written with restrictive permissions",
  );

  const document = await page.evaluate(() => window.paseoDesktop.invoke("get_client_settings"));
  record("1b. get_client_settings IPC round-trip", document);
  assert(document?.version === 1, "get_client_settings returns the document");

  const seed = await page.evaluate(() => window.paseoDesktop.invoke("get_settings_seed"));
  record("1c. XDG settings seed IPC round-trip", seed);
  assert(seed?.path === seedPath, "get_settings_seed reads the XDG config file");
  assert(
    seed?.app?.keyboardShortcutOverrides?.["toggle-sidebar"] === "ctrl+shift+b",
    "get_settings_seed returns the configured shortcut",
  );

  // (2) A registered preference changed in the settings UI lands in the file.
  await openAppearanceSettings(page);
  await page.screenshot({ path: path.join(artifactDir, "settings-appearance.png") });

  await page.getByText("System", { exact: true }).first().click();
  await delay(1_500);
  await page.getByText("Dark", { exact: true }).first().click();
  await delay(1_500);

  const afterThemeChange = await waitForSettings(
    userData,
    (doc) => doc.app?.appSettings?.theme === "dark",
    'settings.json to record theme "dark" after the UI click',
  );
  record("2. The settings UI writes into settings.json", afterThemeChange);
  assert(afterThemeChange.app.appSettings.theme === "dark", "the UI click landed in the file");
  await page.screenshot({ path: path.join(artifactDir, "settings-dark.png") });

  // (3) Unregistered keys never reach the file.
  const localStorageKeys = await page.evaluate(() => Object.keys(window.localStorage).sort());
  const fileFields = Object.keys(afterThemeChange.app).sort();
  const unregistered = fileFields.filter((field) => !REGISTERED_FIELDS.has(field));
  record("3. Unregistered keys stay in local storage", {
    fieldsInSettingsJson: fileFields,
    unregisteredFieldsInSettingsJson: unregistered,
    localStorageKeys,
  });
  assert(unregistered.length === 0, "settings.json holds only registered fields");
  assert(
    localStorageKeys.includes("@paseo:daemon-registry"),
    "an unregistered @paseo key is still in local storage",
  );

  // (4) With no file, the registered local storage values seed one.
  await page.evaluate(() => {
    window.localStorage.setItem("@paseo:preferred-editor", "zed");
    window.localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ theme: "light", uiFontSize: 17 }),
    );
    window.localStorage.setItem(
      "@paseo:keyboard-shortcut-overrides",
      JSON.stringify({ "toggle-sidebar": "ctrl+b" }),
    );
  });
  fs.rmSync(settingsFilePath(userData));
  await reloadApp(page);

  const migrated = await waitForSettings(
    userData,
    (doc) => doc.app?.preferredEditor === "zed",
    "settings.json to be migrated from local storage",
  );
  record("4. Migration seeds the file from local storage", migrated);
  assert(migrated.app.preferredEditor === "zed", "a scalar migrates as a raw string");
  assert(migrated.app.appSettings.theme === "light", "a struct migrates as an object");
  assert(
    migrated.app.keyboardShortcutOverrides["toggle-sidebar"] === "ctrl+b",
    "a record migrates as an object",
  );
  assert(
    (await page.evaluate(() => window.localStorage.getItem("@paseo:preferred-editor"))) === "zed",
    "the legacy local storage value is left in place",
  );

  // The file's existence ends migration: a later local storage edit must not be picked up.
  await page.evaluate(() =>
    window.localStorage.setItem("@paseo:preferred-editor", "should-be-ignored"),
  );
  await reloadApp(page);
  const afterSecondReload = readSettings(userData);
  record("4b. Migration is idempotent across reloads", afterSecondReload);
  assert(
    afterSecondReload.app.preferredEditor === "zed",
    "the file, not local storage, is authoritative after migration",
  );

  // (5) A hand-edited file shows up in the UI. The app is rendering light at size 17 here, and
  // local storage still holds those values, so dark at 22 can only come from the file.
  writeJson(settingsFilePath(userData), {
    version: 1,
    app: {
      appSettings: { theme: "dark", uiFontSize: 22 },
      preferredEditor: "vscode",
    },
  });
  record("5. Hand-edited settings.json", fs.readFileSync(settingsFilePath(userData), "utf8"));

  await reloadApp(page);
  await openAppearanceSettings(page);
  await page.screenshot({ path: path.join(artifactDir, "after-hand-edit.png") });

  const observed = await page.evaluate(() => {
    const labels = new Set(
      [...document.querySelectorAll("*")]
        .filter((element) => element.children.length === 0)
        .map((element) => element.textContent?.trim() ?? ""),
    );
    return {
      themeControlLabel: ["Dark", "Light", "System"].find((v) => labels.has(v)) ?? null,
      staleLocalStorageAppSettings: window.localStorage.getItem("@paseo:app-settings"),
    };
  });
  const live = await page.evaluate(() => window.paseoDesktop.invoke("get_client_settings"));
  record("5b. The hand-edited file wins over local storage", { observed, live });
  assert(live.app.appSettings.uiFontSize === 22, "the hand-edited font size is in the file");
  assert(live.app.preferredEditor === "vscode", "the hand-edited editor is in the file");
  assert(
    observed.themeControlLabel === "Dark",
    `the theme control shows the hand-edited value (saw ${observed.themeControlLabel})`,
  );
  assert(
    observed.staleLocalStorageAppSettings?.includes('"theme":"light"') === true,
    "the UI renders the file while local storage still holds the superseded value",
  );

  return { evidence };
}

async function main() {
  const artifactDir =
    process.env.PASEO_DESKTOP_SETTINGS_FILE_E2E_ARTIFACT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "paseo-desktop-settings-file-e2e-artifacts-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-desktop-settings-file-e2e-"));
  fs.mkdirSync(artifactDir, { recursive: true });
  const paseoHome = path.join(runtimeDir, "paseo-home");
  const userData = path.join(runtimeDir, "electron-user-data");
  const configHome = path.join(runtimeDir, "xdg-config");
  const seedPath = path.join(configHome, "paseo", "settings-seed.json");
  fs.mkdirSync(paseoHome, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  writeJson(seedPath, {
    app: { keyboardShortcutOverrides: { "toggle-sidebar": "ctrl+shift+b" } },
  });

  const [daemonPort, expoPort, cdpPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const listen = `127.0.0.1:${daemonPort}`;

  writeJson(path.join(paseoHome, "config.json"), {
    version: 1,
    daemon: {
      listen,
      relay: { enabled: false },
      mcp: { enabled: false },
      cors: { allowedOrigins: ["*"] },
    },
  });

  const children = [];
  let browser;
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
      XDG_CONFIG_HOME: configHome,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    // An inherited agent/client password makes the app wait on an auth prompt.
    delete commonEnv.PASEO_PASSWORD;
    delete commonEnv.PASEO_AGENT_ID;

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
        ? ["-a", "--server-args=-screen 0 1400x900x24", ...desktopArgs]
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
    await waitForBridge(page);
    await delay(5_000);

    const report = await runRegression({ page, userData, seedPath, artifactDir });
    writeJson(path.join(artifactDir, "result.json"), report);
    console.log("\nDesktop settings file E2E passed.");
  } catch (error) {
    console.error(`Desktop settings file E2E failed. Artifacts: ${artifactDir}`);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.toReversed()) stopProcess(child);
    await delay(2_000);
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`Failed to remove isolated E2E state ${runtimeDir}`, error);
    }
  }
}

await main();
// A run that dies before Electron is up leaves Metro holding an inherited stdout pipe, which keeps
// the event loop alive forever. Teardown is done by here, so leaving is safe and never silent.
process.exit(process.exitCode ?? 0);
