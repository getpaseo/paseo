import type { SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import { createEditorTargetRuntime } from "./runtime.js";

interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
  unrefed: boolean;
}

describe("editor target runtime", () => {
  it("resolves command aliases and safely launches Windows command scripts", async () => {
    const records: SpawnRecord[] = [];
    const runtime = createEditorTargetRuntime({
      platform: "win32",
      env: {
        PATH: "C:/Program Files/Editors & Tools/bin",
        ELECTRON_RUN_AS_NODE: "1",
      },
      pathExists: (targetPath) => targetPath === "C:/Program Files/Editors & Tools/bin/code.cmd",
      spawn: (command, args, options) => {
        const record = { command, args, options, unrefed: false };
        records.push(record);
        const child = {
          once(event: "error" | "spawn", handler: (error?: Error) => void) {
            if (event === "spawn") queueMicrotask(() => handler());
            return child;
          },
          unref() {
            record.unrefed = true;
          },
        };
        return child;
      },
    });

    const command = runtime.resolveCommand(["missing", "code"]);
    if (!command) throw new Error("Expected the editor command to resolve");
    await runtime.spawnDetached({
      command,
      args: ["C:/repo & workspace", "C:/repo/src/file & calculator.ts"],
    });

    expect(records).toEqual([
      {
        command: '"C:/Program Files/Editors & Tools/bin/code.cmd"',
        args: ['"C:/repo & workspace"', '"C:/repo/src/file & calculator.ts"'],
        options: {
          detached: true,
          env: { PATH: "C:/Program Files/Editors & Tools/bin" },
          shell: true,
          stdio: "ignore",
        },
        unrefed: true,
      },
    ]);
  });

  it("launches an explicitly selected macOS application bundle", async () => {
    const records: SpawnRecord[] = [];
    const runtime = createEditorTargetRuntime({
      platform: "darwin",
      env: {},
      homeDirectory: "/Users/me",
      // A version manager leaves Xcode.app as a symlink beside the real
      // bundles, so `open -a Xcode` finds no uniquely named application.
      pathExists: (targetPath) => targetPath === "/Applications/Xcode.app",
      spawn: (command, args, options) => {
        const record = { command, args, options, unrefed: false };
        records.push(record);
        const child = {
          once(event: "error" | "spawn", handler: (error?: Error) => void) {
            if (event === "spawn") queueMicrotask(() => handler());
            return child;
          },
          unref() {
            record.unrefed = true;
          },
        };
        return child;
      },
    });

    expect(runtime.hasMacApplication("Xcode")).toBe(true);
    const applicationPath = runtime.getMacApplicationBundle("Xcode");
    if (!applicationPath) throw new Error("Expected Xcode to resolve");
    await runtime.openMacApplication({
      applicationName: "Xcode",
      applicationPath,
      paths: ["/repo/App.xcworkspace"],
    });

    expect(records.map((record) => ({ command: record.command, args: record.args }))).toEqual([
      {
        command: "/usr/bin/open",
        args: ["-a", "/Applications/Xcode.app", "/repo/App.xcworkspace"],
      },
    ]);
  });

  it("uses LaunchServices application-name resolution by default", async () => {
    const records: SpawnRecord[] = [];
    const runtime = createEditorTargetRuntime({
      platform: "darwin",
      env: {},
      pathExists: (targetPath) => targetPath === "/Applications/Cursor.app",
      spawn: (command, args, options) => {
        const record = { command, args, options, unrefed: false };
        records.push(record);
        const child = {
          once(event: "error" | "spawn", handler: (error?: Error) => void) {
            if (event === "spawn") queueMicrotask(() => handler());
            return child;
          },
          unref() {
            record.unrefed = true;
          },
        };
        return child;
      },
    });

    await runtime.openMacApplication({ applicationName: "Cursor", paths: ["/repo"] });

    expect(records[0]?.args).toEqual(["-a", "Cursor", "/repo"]);
  });

  it("surfaces directory read errors", () => {
    const readError = new Error("Permission denied");
    const runtime = createEditorTargetRuntime({
      platform: "darwin",
      env: {},
      readDirectory: () => {
        throw readError;
      },
    });

    expect(() => runtime.listDirectory("/repo")).toThrow(readError);
  });

  it("strips AppImage runtime variables from detached Linux editor launches", async () => {
    const records: SpawnRecord[] = [];
    const appDir = "/tmp/.mount_Paseo-editor";
    const callerEnv: NodeJS.ProcessEnv = {
      APPIMAGE: "/home/user/app/Paseo-x86_64.AppImage",
      APPDIR: appDir,
      ARGV0: "/home/user/app/Paseo-x86_64.AppImage",
      OWD: "/home/user",
      APPIMAGE_LIBRARY_PATH: `${appDir}/usr/lib`,
      PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin`,
      LD_LIBRARY_PATH: `${appDir}/usr/lib:/opt/lib`,
      XDG_DATA_DIRS: `${appDir}/usr/share:/usr/share`,
      GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
      HOME: "/home/user",
    };
    const runtime = createEditorTargetRuntime({
      platform: "linux",
      env: callerEnv,
      pathExists: (targetPath) => targetPath === "/usr/local/bin/code",
      spawn: (command, args, options) => {
        const record = { command, args, options, unrefed: false };
        records.push(record);
        const child = {
          once(event: "error" | "spawn", handler: (error?: Error) => void) {
            if (event === "spawn") queueMicrotask(() => handler());
            return child;
          },
          unref() {
            record.unrefed = true;
          },
        };
        return child;
      },
    });

    await runtime.spawnDetached({
      command: "/usr/local/bin/code",
      args: ["/repo"],
    });

    const childEnv = records[0]?.options.env ?? {};
    expect("APPIMAGE" in childEnv).toBe(false);
    expect("APPDIR" in childEnv).toBe(false);
    expect("ARGV0" in childEnv).toBe(false);
    expect("OWD" in childEnv).toBe(false);
    expect("APPIMAGE_LIBRARY_PATH" in childEnv).toBe(false);
    expect(childEnv.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(childEnv.LD_LIBRARY_PATH).toBe("/opt/lib");
    expect(childEnv.XDG_DATA_DIRS).toBe("/usr/share");
    expect("GSETTINGS_SCHEMA_DIR" in childEnv).toBe(false);
    expect(childEnv.HOME).toBe("/home/user");
    expect(callerEnv.APPIMAGE).toBe("/home/user/app/Paseo-x86_64.AppImage");
  });
});
