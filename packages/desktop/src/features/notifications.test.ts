import { describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: never[]) => unknown>();

vi.mock("electron", () => ({
  app: { name: "Paseo" },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  Notification: vi.fn(),
  ipcMain: {
    handle: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler);
    }),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  },
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => ({ notifications: { playSound: true } }),
  }),
}));

import {
  buildNotifySendArgs,
  LINUX_NOTIFICATION_SOUND_NAME,
  sendLinuxNotificationWithSound,
  shouldUseLinuxSoundNotification,
  type NotifySendProcess,
  type NotifySendSpawner,
} from "./notifications";

function createFakeProcess(): NotifySendProcess & {
  emitError(error: Error): void;
  emitClose(code: number | null): void;
  emitStdout(text: string): void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const stdoutListeners = new Array<(chunk: unknown) => void>();
  const process = {
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    unref() {},
    kill() {},
    stdout: {
      on(event: string, listener: (chunk: unknown) => void) {
        if (event === "data") {
          stdoutListeners.push(listener);
        }
      },
    },
    emitError(error: Error) {
      for (const listener of listeners.get("error") ?? []) {
        listener(error);
      }
    },
    emitClose(code: number | null) {
      for (const listener of listeners.get("close") ?? []) {
        listener(code);
      }
    },
    emitStdout(text: string) {
      for (const listener of stdoutListeners) {
        listener(text);
      }
    },
  };
  return process;
}

describe("linux notification sound", () => {
  it("attaches the verified sound-name hint to notify-send args", () => {
    expect(LINUX_NOTIFICATION_SOUND_NAME).toBe("complete");
    expect(
      buildNotifySendArgs({
        appName: "Paseo",
        iconPath: "/icons/app.png",
        title: "Agent finished",
        body: "Done",
      }),
    ).toEqual([
      "-a",
      "Paseo",
      "-u",
      "normal",
      "-h",
      "string:sound-name:complete",
      "-A",
      "default=Open",
      "-i",
      "/icons/app.png",
      "Agent finished",
      "Done",
    ]);
  });

  it("omits icon and body flags when absent", () => {
    expect(buildNotifySendArgs({ appName: "Paseo", iconPath: null, title: "Hi" })).toEqual([
      "-a",
      "Paseo",
      "-u",
      "normal",
      "-h",
      "string:sound-name:complete",
      "-A",
      "default=Open",
      "Hi",
    ]);
  });

  it("only uses the notify-send path on linux with play sound on", () => {
    expect(shouldUseLinuxSoundNotification("linux", true)).toBe(true);
    expect(shouldUseLinuxSoundNotification("linux", false)).toBe(false);
    expect(shouldUseLinuxSoundNotification("darwin", true)).toBe(false);
    expect(shouldUseLinuxSoundNotification("win32", true)).toBe(false);
  });

  it("reports sent once notify-send stays alive past the spawn grace", async () => {
    const seen: string[][] = [];
    const spawner: NotifySendSpawner = (command, args) => {
      seen.push([command, ...args]);
      return createFakeProcess();
    };

    const sent = await sendLinuxNotificationWithSound(
      { appName: "Paseo", iconPath: null, title: "Hi" },
      undefined,
      spawner,
      10,
    );

    expect(sent).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe("notify-send");
    expect(seen[0]).toContain("string:sound-name:complete");
  });

  it("reports failure when notify-send is missing so the caller falls back", async () => {
    const spawner: NotifySendSpawner = () => {
      const process = createFakeProcess();
      queueMicrotask(() => process.emitError(new Error("spawn notify-send ENOENT")));
      return process;
    };

    const sent = await sendLinuxNotificationWithSound(
      { appName: "Paseo", iconPath: null, title: "Hi" },
      undefined,
      spawner,
      50,
    );

    expect(sent).toBe(false);
  });

  it("reports failure when the spawner throws synchronously", async () => {
    const spawner: NotifySendSpawner = () => {
      throw new Error("nope");
    };

    await expect(
      sendLinuxNotificationWithSound(
        { appName: "Paseo", iconPath: null, title: "Hi" },
        undefined,
        spawner,
      ),
    ).resolves.toBe(false);
  });

  it("delivers late clicks to the action handler", async () => {
    const actions: string[] = [];
    const spawner: NotifySendSpawner = () => {
      const process = createFakeProcess();
      queueMicrotask(() => {
        process.emitStdout("default\n");
        process.emitClose(0);
      });
      return process;
    };

    const sent = await sendLinuxNotificationWithSound(
      { appName: "Paseo", iconPath: null, title: "Hi" },
      (actionId) => actions.push(actionId),
      spawner,
      50,
    );

    expect(sent).toBe(true);
    expect(actions).toEqual(["default"]);
  });
});
