import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { LocalUpdatePolicy } from "./local-update-policy.js";

interface SavedWindow {
  route: string;
  bounds: Electron.Rectangle;
  maximized: boolean;
}
interface Activation {
  target: string;
  windows: SavedWindow[];
  popup?: unknown;
}

export function readLocalBuildId(appPath: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path.join(appPath, "dist/local-build.json"), "utf8"));
    return typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit)
      ? value.commit
      : null;
  } catch {
    return null;
  }
}

/** One activation owns all app windows, including the external plan window. Never owns the daemon. */
export function registerLocalUpdate(
  active: string,
  options: { resourcesPath?: string; now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const policy = new LocalUpdatePolicy(active, now());
  const statePath = path.join(app.getPath("userData"), "local-activation.json");
  const statusPath = path.join(app.getPath("userData"), "local-release-status.json");
  const installedPath = path.join(
    options.resourcesPath ?? process.resourcesPath,
    "local-release.json",
  );
  const windows = new Map<number, { window: BrowserWindow; popup: boolean; ready: boolean }>();
  const preparations = new Map<string, (result: { ok: boolean; state?: unknown }) => void>();
  let restore: Activation | null = null;
  let lastCheck = 0;
  let activating = false;
  let startupComplete = false;
  let startupFailed = false;
  try {
    if (existsSync(statePath)) restore = JSON.parse(readFileSync(statePath, "utf8"));
    if (restore && restore.target !== active) {
      policy.fail(
        "La relance n’a pas chargé la version attendue. Relancez Paseo Local manuellement.",
      );
      startupFailed = true;
    }
  } catch {
    policy.fail(
      "Impossible de restaurer la mise à jour. Les tentatives automatiques sont suspendues.",
    );
    startupFailed = true;
  }
  function writeJson(file: string, value: unknown) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  }
  function publish() {
    const status = { ...policy.status };
    for (const entry of windows.values()) {
      if (!entry.window.isDestroyed())
        entry.window.webContents.send("paseo:local-update:status", status);
    }
    writeJson(statusPath, {
      ...status,
      pid: process.pid,
      verified: startupComplete && !startupFailed,
      checkedAt: now(),
    });
  }
  function authorized(event: IpcMainInvokeEvent) {
    return event.senderFrame === event.sender.mainFrame && windows.has(event.sender.id);
  }
  function check() {
    try {
      const value = JSON.parse(readFileSync(installedPath, "utf8"));
      if (!startupFailed && typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit))
        policy.installed(value.commit);
    } catch {
      /* An installation in progress is not a usable release. */
    }
    lastCheck = now();
    publish();
  }
  function verifyReady() {
    const entries = [...windows.values()];
    const expectedMain = restore?.windows.length ?? 1;
    if (
      !startupFailed &&
      entries.filter((w) => !w.popup && w.ready).length >= expectedMain &&
      entries.every((w) => w.ready) &&
      (!restore?.popup || entries.some((w) => w.popup && w.ready))
    ) {
      startupComplete = true;
      writeJson(statePath, null);
      publish();
    }
  }
  ipcMain.handle("paseo:local-update:ready", (event, id: unknown) => {
    if (!authorized(event)) return null;
    if (id !== active) {
      startupFailed = true;
      policy.fail("Une fenêtre utilise une autre version. Relancez Paseo Local manuellement.");
    } else windows.get(event.sender.id)!.ready = true;
    verifyReady();
    publish();
    return policy.status;
  });
  ipcMain.handle("paseo:local-update:postpone", (event) => {
    if (authorized(event)) {
      policy.postpone(now());
      publish();
    }
  });
  ipcMain.handle("paseo:local-update:activity", (event) => {
    if (authorized(event)) {
      policy.activity(now());
      publish();
    }
  });
  ipcMain.handle("paseo:local-update:prepared", (event, token: unknown, value: unknown) => {
    if (!authorized(event) || typeof token !== "string" || !value || typeof value !== "object")
      return;
    const result = value as { ok?: unknown; state?: unknown };
    if (typeof result.ok !== "boolean") return;
    preparations.get(`${event.sender.id}:${token}`)?.({ ok: result.ok, state: result.state });
  });
  ipcMain.handle("paseo:local-update:popup-state", (event) => {
    if (!authorized(event) || !windows.get(event.sender.id)?.popup) return null;
    return restore?.popup ?? null;
  });
  async function prepare(entry: typeof windows extends Map<number, infer T> ? T : never) {
    const token = randomUUID();
    const key = `${entry.window.webContents.id}:${token}`;
    const acknowledged = new Promise<{ ok: boolean; state?: unknown }>((resolve) => {
      preparations.set(key, resolve);
    });
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<{ ok: boolean; state?: unknown }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false }), 10_000);
    });
    entry.window.webContents.send("paseo:local-update:prepare", token);
    return Promise.race([acknowledged, timedOut]).finally(() => {
      clearTimeout(timer);
      preparations.delete(key);
    });
  }

  async function activate() {
    activating = true;
    try {
      const entries = [...windows.values()];
      const result = await Promise.all(entries.map(prepare));
      if (
        result.some((value) => !value.ok) ||
        entries.length !== windows.size ||
        entries.some((e) => e.window.isDestroyed())
      ) {
        policy.status.phase = "ready";
        policy.activity(now());
        return;
      }
      // Input during the asynchronous flush invalidates the idle decision too.
      if (policy.status.phase !== "activating") return;
      const snapshot: Activation = {
        target: policy.status.installed,
        windows: entries
          .filter((e) => !e.popup)
          .map(({ window }) => {
            const url = new URL(window.webContents.getURL());
            return {
              route: url.pathname + url.search + url.hash,
              bounds: window.getBounds(),
              maximized: window.isMaximized(),
            };
          }),
        popup: result.find((_value, index) => entries[index]!.popup)?.state,
      };
      writeJson(statePath, snapshot);
      publish();
      app.relaunch();
      // Intentional UI-only exit: normal before-quit can stop the daemon by preference.
      app.exit(0);
    } catch (error) {
      policy.fail(
        `Activation impossible : ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      activating = false;
      publish();
    }
  }
  const timer = setInterval(() => {
    if (now() - lastCheck >= 30_000) check();
    if (!startupComplete || startupFailed || activating) return;
    policy.tick(now());
    publish();
    if (policy.status.phase === "activating") void activate();
  }, 1000);
  timer.unref();
  const startupTimer = setTimeout(() => {
    if (startupComplete) return;
    startupFailed = true;
    policy.fail(
      "La nouvelle interface n’a pas confirmé son démarrage. Relancez Paseo Local manuellement.",
    );
    publish();
  }, 60_000);
  startupTimer.unref();
  check();
  return {
    active,
    restoreWindows: restore?.windows ?? [],
    attach(window: BrowserWindow, popup = false) {
      const id = window.webContents.id;
      windows.set(id, { window, popup, ready: false });
      window.on("focus", check);
      window.on("closed", () => {
        windows.delete(id);
        policy.activity(now());
      });
      window.webContents.on("before-input-event", () => {
        policy.activity(now());
      });
    },
  };
}
