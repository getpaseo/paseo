#!/usr/bin/env npx tsx

import assert from "node:assert";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Command } from "commander";
import { isBearerTokenValid } from "@getpaseo/server";
import {
  runSetPasswordCommand,
  setDaemonPasswordInConfig,
  type PromptPassword,
} from "../src/commands/daemon/set-password.ts";
import {
  isInteractiveTerminal,
  isWindowsElectronRunAsNode,
  PASSWORD_ALTERNATES_DETAILS,
  promptPasswordViaWindowsConsole,
  type SpawnFn,
} from "../src/utils/interactive-password.ts";

console.log("=== Daemon Set Password Command ===\n");

const root = await mkdtemp(join(tmpdir(), "paseo-set-password-"));
const paseoHome = join(root, ".paseo");

function promptSequence(values: Array<string | symbol>): PromptPassword {
  return async () => {
    const value = values.shift();
    if (value === undefined) {
      throw new Error("prompt called too many times");
    }
    return value;
  };
}

function createFakeChild(stdoutText: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
  };
  child.stdout = new PassThrough();
  queueMicrotask(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    queueMicrotask(() => {
      child.emit("close", exitCode, null);
    });
  });
  return child;
}

try {
  {
    console.log("Test 1: setDaemonPasswordInConfig writes hash and preserves config fields");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      join(paseoHome, "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          daemon: {
            listen: "127.0.0.1:9999",
            relay: { enabled: false },
          },
          app: { baseUrl: "https://app.paseo.sh" },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setDaemonPasswordInConfig("shared-secret", { home: paseoHome });
    const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf-8"));

    assert.strictEqual(result.configPath, join(paseoHome, "config.json"));
    assert.strictEqual(result.restartCommand, "paseo daemon restart");
    assert.strictEqual(config.daemon.listen, "127.0.0.1:9999");
    assert.strictEqual(config.daemon.relay.enabled, false);
    assert.notStrictEqual(config.daemon.auth.password, "shared-secret");
    assert.match(config.daemon.auth.password, /^\$2[aby]\$12\$/);
    assert.strictEqual(
      isBearerTokenValid({ password: config.daemon.auth.password, token: "shared-secret" }),
      true,
    );
    console.log("✓ set-password writes bcrypt hash without clobbering config\n");
  }

  {
    console.log("Test 2: command prompts twice and accepts matching confirmation");
    const result = await runSetPasswordCommand(
      {
        home: paseoHome,
        promptPassword: promptSequence(["new-secret", "new-secret"]),
      },
      {} as Command,
    );
    const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf-8"));

    assert.strictEqual(result.data.action, "password_set");
    assert.strictEqual(
      isBearerTokenValid({ password: config.daemon.auth.password, token: "new-secret" }),
      true,
    );
    console.log("✓ command accepts matching confirmation\n");
  }

  {
    console.log("Test 3: command refuses mismatched confirmation");
    await assert.rejects(
      runSetPasswordCommand(
        {
          home: paseoHome,
          promptPassword: promptSequence(["first-secret", "second-secret"]),
        },
        {} as Command,
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "PASSWORD_MISMATCH",
    );
    console.log("✓ command refuses password mismatch\n");
  }

  {
    console.log("Test 4: --password skips prompts and writes hash");
    let prompted = false;
    const result = await runSetPasswordCommand(
      {
        home: paseoHome,
        password: "flag-secret",
        promptPassword: async () => {
          prompted = true;
          return "should-not-run";
        },
      },
      {} as Command,
    );
    const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf-8"));

    assert.strictEqual(prompted, false);
    assert.strictEqual(result.data.action, "password_set");
    assert.strictEqual(
      isBearerTokenValid({ password: config.daemon.auth.password, token: "flag-secret" }),
      true,
    );
    console.log("✓ --password skips prompts\n");
  }

  {
    console.log("Test 5: PASEO_SET_PASSWORD env skips prompts");
    let prompted = false;
    const result = await runSetPasswordCommand(
      {
        home: paseoHome,
        env: { PASEO_SET_PASSWORD: "env-secret" },
        promptPassword: async () => {
          prompted = true;
          return "should-not-run";
        },
      },
      {} as Command,
    );
    const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf-8"));

    assert.strictEqual(prompted, false);
    assert.strictEqual(result.data.action, "password_set");
    assert.strictEqual(
      isBearerTokenValid({ password: config.daemon.auth.password, token: "env-secret" }),
      true,
    );
    console.log("✓ PASEO_SET_PASSWORD skips prompts\n");
  }

  {
    console.log("Test 6: empty --password is rejected");
    await assert.rejects(
      runSetPasswordCommand(
        {
          home: paseoHome,
          password: "",
        },
        {} as Command,
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "PASSWORD_REQUIRED",
    );
    console.log("✓ empty --password rejected\n");
  }

  {
    console.log("Test 7: non-interactive terminal without password fails clearly");
    await assert.rejects(
      runSetPasswordCommand(
        {
          home: paseoHome,
          process: {
            platform: "linux",
            versions: {} as NodeJS.ProcessVersions,
            env: {},
            execPath: "/usr/bin/node",
            stdin: { isTTY: false },
            stdout: { isTTY: false },
          },
        },
        {} as Command,
      ),
      (error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error)) {
          return false;
        }
        const commandError = error as { code: string; details?: string };
        return (
          commandError.code === "PASSWORD_PROMPT_UNAVAILABLE" &&
          typeof commandError.details === "string" &&
          commandError.details.includes("--password") &&
          commandError.details.includes("npx -y @getpaseo/cli daemon set-password") &&
          commandError.details.includes(PASSWORD_ALTERNATES_DETAILS.split("\n")[0]!)
        );
      },
    );
    console.log("✓ non-interactive failure points to --password / npx\n");
  }

  {
    console.log("Test 8: Windows Electron path uses console bridge, not injected clack path");
    let windowsPrompts = 0;
    const result = await runSetPasswordCommand(
      {
        home: paseoHome,
        process: {
          platform: "win32",
          versions: { electron: "39.0.0" } as NodeJS.ProcessVersions,
          env: { ELECTRON_RUN_AS_NODE: "1" },
          execPath: "C:\\Users\\chenx\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
          stdin: { isTTY: true },
          stdout: { isTTY: true },
        },
        promptWindowsConsole: async () => {
          windowsPrompts += 1;
          return "bridge-secret";
        },
      },
      {} as Command,
    );
    const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf-8"));

    assert.strictEqual(windowsPrompts, 2);
    assert.strictEqual(result.data.action, "password_set");
    assert.strictEqual(
      isBearerTokenValid({ password: config.daemon.auth.password, token: "bridge-secret" }),
      true,
    );
    console.log("✓ Windows Electron uses console bridge\n");
  }

  {
    console.log("Test 9: Windows Electron bridge failure surfaces actionable error");
    await assert.rejects(
      runSetPasswordCommand(
        {
          home: paseoHome,
          process: {
            platform: "win32",
            versions: { electron: "39.0.0" } as NodeJS.ProcessVersions,
            env: { ELECTRON_RUN_AS_NODE: "1" },
            execPath: "C:\\Program Files\\Paseo\\Paseo.exe",
            stdin: { isTTY: true },
            stdout: { isTTY: true },
          },
          promptWindowsConsole: async () => {
            throw new Error("spawn powershell.exe ENOENT");
          },
        },
        {} as Command,
      ),
      (error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error)) {
          return false;
        }
        const commandError = error as { code: string; details?: string; message?: string };
        return (
          commandError.code === "PASSWORD_PROMPT_UNAVAILABLE" &&
          typeof commandError.details === "string" &&
          commandError.details.includes("spawn powershell.exe ENOENT") &&
          commandError.details.includes("paseo daemon set-password --password")
        );
      },
    );
    console.log("✓ bridge failure includes --password / npx guidance\n");
  }

  {
    console.log("Test 10: isWindowsElectronRunAsNode detection");
    assert.strictEqual(
      isWindowsElectronRunAsNode({
        platform: "win32",
        versions: { electron: "39.0.0" } as NodeJS.ProcessVersions,
        env: {},
        execPath: "C:\\Program Files\\Paseo\\Paseo.exe",
      }),
      true,
    );
    assert.strictEqual(
      isWindowsElectronRunAsNode({
        platform: "win32",
        versions: {} as NodeJS.ProcessVersions,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "C:\\Program Files\\Paseo\\Paseo.exe",
      }),
      true,
    );
    assert.strictEqual(
      isWindowsElectronRunAsNode({
        platform: "win32",
        versions: {} as NodeJS.ProcessVersions,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "C:\\Program Files\\nodejs\\node.exe",
      }),
      false,
    );
    assert.strictEqual(
      isWindowsElectronRunAsNode({
        platform: "linux",
        versions: { electron: "39.0.0" } as NodeJS.ProcessVersions,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "/opt/Paseo/paseo",
      }),
      false,
    );
    assert.strictEqual(
      isInteractiveTerminal({
        stdin: { isTTY: true },
        stdout: { isTTY: true },
      }),
      true,
    );
    assert.strictEqual(
      isInteractiveTerminal({
        stdin: { isTTY: false },
        stdout: { isTTY: true },
      }),
      false,
    );
    console.log("✓ Electron/TTY detection helpers\n");
  }

  {
    console.log("Test 11: promptPasswordViaWindowsConsole builds PowerShell spawn");
    let captured: { command: string; args: readonly string[]; options: unknown } | undefined;
    const spawnImpl: SpawnFn = ((command, args, options) => {
      captured = { command, args, options };
      return createFakeChild("bridged-password\n") as ReturnType<SpawnFn>;
    }) as SpawnFn;

    const value = await promptPasswordViaWindowsConsole("New daemon password", spawnImpl);
    assert.strictEqual(value, "bridged-password");
    assert.ok(captured);
    assert.strictEqual(captured.command, "powershell.exe");
    assert.deepStrictEqual(captured.args.slice(0, 2), ["-NoProfile", "-Command"]);
    assert.match(String(captured.args[2]), /Read-Host/);
    assert.match(String(captured.args[2]), /AsSecureString/);
    const options = captured.options as {
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
      windowsHide?: boolean;
    };
    assert.strictEqual(options.env?.PASEO_PASSWORD_PROMPT, "New daemon password");
    assert.deepStrictEqual(options.stdio, ["inherit", "pipe", "inherit"]);
    assert.strictEqual(options.windowsHide, false);
    console.log("✓ Windows console spawn argv/env\n");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("=== Daemon Set Password Command Tests Passed ===");
