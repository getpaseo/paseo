import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPlatform } from "../../../test-utils/platform.js";
import { buildTerminalEnvironment } from "../../terminal.js";
import {
  buildAgentHookShellCommand,
  buildAgentHookWindowsPowerShellCommand,
} from "../agent-hook-installer.js";
import {
  AGENT_HOOK_PROVIDERS,
  installRegisteredAgentHooks,
  registeredAgentHooksAreInstalled,
  uninstallRegisteredAgentHooks,
} from "../provider-registry.js";

const temporaryDirs: string[] = [];
afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function createFakeCliBinDir(): string {
  const dir = createTempDir("paseo-cli-bin-");
  writeFileSync(join(dir, "paseo"), "");
  return dir;
}

interface TestClaudeSettings {
  hooks?: Record<string, unknown>;
  theme?: string;
}

function readSettings(configDir: string): TestClaudeSettings {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
    hooks?: Record<string, unknown>;
    theme?: string;
  };
}

function hookCommands(settings: { hooks?: Record<string, unknown> }, event: string): string[] {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      return [];
    }
    return entry.hooks
      .map((hook) => (isRecord(hook) ? hook.command : undefined))
      .filter((command): command is string => typeof command === "string");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runWindowsHook(command: string, env: NodeJS.ProcessEnv, input?: string) {
  const parts = command.split(" ");
  return spawnSync(parts[0]!, parts.slice(1), {
    env,
    encoding: "utf8",
    input,
    timeout: 10_000,
    windowsHide: true,
  });
}

function installedClaudeHookCommand(event: string): string {
  const configDir = createTempDir("paseo-claude-installed-hook-");
  installRegisteredAgentHooks({ configDir });
  const commands = hookCommands(readSettings(configDir), event);
  if (commands.length !== 1) {
    throw new Error(`Expected one installed Claude hook for ${event}, got ${commands.length}`);
  }
  return commands[0]!;
}

function claudeEvent(eventName: string) {
  const definition = AGENT_HOOK_PROVIDERS.claude.events.find(
    ({ event: candidate }) => candidate === eventName,
  );
  if (!definition) {
    throw new Error(`Claude provider is missing the ${eventName} event`);
  }
  return definition;
}

function hookMatchers(settings: TestClaudeSettings, event: string): unknown[] {
  const matchers = settings.hooks?.[event];
  if (!Array.isArray(matchers)) {
    throw new Error(`Claude settings are missing hooks for ${event}`);
  }
  return matchers;
}

describe("Claude terminal agent hooks", () => {
  it("installs registered provider hooks idempotently", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const provider = AGENT_HOOK_PROVIDERS.claude;

    const firstInstall = installRegisteredAgentHooks({ configDir });
    const secondInstall = installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    for (const event of provider.events) {
      expect(hookCommands(settings, event.event)).toHaveLength(1);
    }
    expect(firstInstall.every((result) => result.changed)).toBe(true);
    expect(secondInstall.every((result) => !result.changed)).toBe(true);
    expect(registeredAgentHooksAreInstalled({ configDir })).toBe(true);
  });

  it.skipIf(isPlatform("win32"))("installs POSIX hook commands on macOS and Linux", () => {
    const configDir = createTempDir("paseo-claude-posix-command-");
    const provider = AGENT_HOOK_PROVIDERS.claude;

    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    for (const event of provider.events) {
      expect(hookCommands(settings, event.event)).toEqual([
        buildAgentHookShellCommand(provider, event),
      ]);
    }
  });

  it.skipIf(!isPlatform("win32"))("installs PowerShell hook commands on Windows", () => {
    const configDir = createTempDir("paseo-claude-windows-command-");
    const provider = AGENT_HOOK_PROVIDERS.claude;

    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    for (const event of provider.events) {
      expect(hookCommands(settings, event.event)).toEqual([
        buildAgentHookWindowsPowerShellCommand(provider, event),
      ]);
    }
  });

  it("preserves unrelated user hooks", () => {
    const configDir = createTempDir("paseo-claude-config-preserve-");
    writeFileSync(
      join(configDir, "settings.json"),
      `${JSON.stringify(
        {
          theme: "dark",
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "say done", timeout: 5 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    expect(settings.theme).toBe("dark");
    const commands = hookCommands(settings, "Stop");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe("say done");
  });

  it("uninstalls current and legacy Paseo hooks while preserving user hooks", () => {
    const configDir = createTempDir("paseo-claude-config-uninstall-");
    installRegisteredAgentHooks({ configDir });
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const stopEvent = claudeEvent("Stop");
    const settings = readSettings(configDir);
    settings.hooks = {
      ...settings.hooks,
      Stop: [
        ...hookMatchers(settings, "Stop"),
        {
          matcher: "",
          hooks: [{ type: "command", command: buildAgentHookShellCommand(provider, stopEvent) }],
        },
        {
          matcher: "",
          hooks: [{ type: "command", command: "say still-here", timeout: 5 }],
        },
      ],
    };
    writeFileSync(join(configDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

    uninstallRegisteredAgentHooks({ configDir });

    const nextSettings = readSettings(configDir);
    expect(hookCommands(nextSettings, "Stop")).toEqual(["say still-here"]);
    expect(registeredAgentHooksAreInstalled({ configDir })).toBe(false);
  });

  it("builds a minimal gated hook command", () => {
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const command = buildAgentHookShellCommand(provider, provider.events[0]);

    expect(command).toBe(
      'if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo}" hooks claude UserPromptSubmit; fi',
    );
  });

  it("builds a UTF-16LE encoded Windows PowerShell command", () => {
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const command = buildAgentHookWindowsPowerShellCommand(provider, provider.events[0]);
    const prefix = "powershell.exe -NoProfile -NonInteractive -EncodedCommand ";

    expect(command.startsWith(prefix)).toBe(true);
    expect(Buffer.from(command.slice(prefix.length), "base64").toString("utf16le")).toBe(
      [
        "if ([string]::IsNullOrEmpty($env:PASEO_TERMINAL_ID)) { exit 0 }",
        "$cli = $env:PASEO_HOOK_CLI",
        "if ([string]::IsNullOrEmpty($cli)) { $cli = 'paseo' }",
        "& $cli 'hooks' 'claude' 'UserPromptSubmit'",
        "$hookSucceeded = $?",
        "$hookExitCode = $LASTEXITCODE",
        "if ($hookSucceeded) { if ($null -ne $hookExitCode) { exit $hookExitCode }; exit 0 }",
        "if ($null -ne $hookExitCode) { exit $hookExitCode }",
        "exit 1",
      ].join("\n"),
    );
  });

  it.skipIf(isPlatform("win32")).each(AGENT_HOOK_PROVIDERS.claude.events)(
    "$event hook command exits 0 when PASEO_TERMINAL_ID is unset",
    (event) => {
      const provider = AGENT_HOOK_PROVIDERS.claude;
      const command = buildAgentHookShellCommand(provider, event);

      const result = spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: process.env.PATH ?? "", PASEO_HOOK_CLI: "paseo" },
        stdio: "ignore",
      });

      expect(result.status).toBe(0);
    },
  );

  describe.skipIf(!isPlatform("win32"))("Windows PowerShell hook commands", () => {
    it.each(AGENT_HOOK_PROVIDERS.claude.events)(
      "exits 0 when PASEO_TERMINAL_ID is unset for $event",
      (event) => {
        const command = installedClaudeHookCommand(event.event);

        const result = runWindowsHook(command, { PATH: process.env.PATH ?? "" });

        expect(result.status).toBe(0);
      },
    );

    it("does not invoke PASEO_HOOK_CLI when PASEO_TERMINAL_ID is unset", () => {
      const binDir = createTempDir("paseo-claude-win-guard-");
      const hookCli = join(binDir, "paseo-fail.cmd");
      const marker = join(binDir, "marker.txt");
      writeFileSync(hookCli, '@echo off\r\necho %* > "%PASEO_HOOK_TEST_MARKER%"\r\nexit /b 1\r\n');
      const command = installedClaudeHookCommand("UserPromptSubmit");

      const result = runWindowsHook(command, {
        PASEO_HOOK_CLI: hookCli,
        PASEO_HOOK_TEST_MARKER: marker,
        PATH: process.env.PATH ?? process.env.Path ?? "",
      });

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });

    it("runs the configured PASEO_HOOK_CLI when it contains spaces", () => {
      const binDir = createTempDir("paseo-claude-win-cli-");
      const spacedDir = join(binDir, "path with spaces");
      mkdirSync(spacedDir);
      const hookCli = join(spacedDir, "paseo with spaces.cmd");
      const marker = join(binDir, "marker.txt");
      writeFileSync(hookCli, '@echo off\r\necho %* > "%PASEO_HOOK_TEST_MARKER%"\r\nexit /b 0\r\n');
      const command = installedClaudeHookCommand("UserPromptSubmit");

      const result = runWindowsHook(command, {
        PASEO_TERMINAL_ID: "test-terminal",
        PASEO_HOOK_CLI: hookCli,
        PASEO_HOOK_TEST_MARKER: marker,
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        PATH: process.env.PATH ?? process.env.Path ?? "",
      });

      expect(result.status).toBe(0);
      expect(readFileSync(marker, "utf8").trim()).toBe("hooks claude UserPromptSubmit");
    });

    it("propagates a configured command shim's nonzero exit code", () => {
      const binDir = createTempDir("paseo-claude-win-exit-");
      const hookCli = join(binDir, "paseo-exit.cmd");
      const marker = join(binDir, "marker.txt");
      writeFileSync(hookCli, '@echo off\r\necho %* > "%PASEO_HOOK_TEST_MARKER%"\r\nexit /b 7\r\n');
      const command = installedClaudeHookCommand("Stop");

      const result = runWindowsHook(command, {
        PASEO_TERMINAL_ID: "test-terminal",
        PASEO_HOOK_CLI: hookCli,
        PASEO_HOOK_TEST_MARKER: marker,
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        PATH: process.env.PATH ?? process.env.Path ?? "",
      });

      expect(result.status).toBe(7);
      expect(readFileSync(marker, "utf8").trim()).toBe("hooks claude Stop");
    });

    it("propagates a native executable's nonzero exit code", () => {
      const hookCli = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "find.exe");
      expect(existsSync(hookCli)).toBe(true);
      const command = installedClaudeHookCommand("Stop");

      const result = runWindowsHook(command, {
        ...process.env,
        PASEO_TERMINAL_ID: "test-terminal",
        PASEO_HOOK_CLI: hookCli,
      });

      expect(result.status).toBe(2);
    });

    it("exits 1 when the configured hook CLI cannot be resolved", () => {
      const command = installedClaudeHookCommand("StopFailure");

      const result = runWindowsHook(command, {
        PASEO_TERMINAL_ID: "test-terminal",
        PASEO_HOOK_CLI: "paseo-hook-cli-that-does-not-exist",
        PATH: process.env.PATH ?? process.env.Path ?? "",
      });

      expect(result.status).toBe(1);
    });

    it("falls back to paseo on PATH when PASEO_HOOK_CLI is unset", () => {
      const binDir = createTempDir("paseo-claude-win-path-");
      const paseoCmd = join(binDir, "paseo.cmd");
      const marker = join(binDir, "marker.txt");
      writeFileSync(paseoCmd, '@echo off\r\necho %* > "%PASEO_HOOK_TEST_MARKER%"\r\nexit /b 0\r\n');
      const command = installedClaudeHookCommand("UserPromptSubmit");

      const path = [binDir, process.env.PATH ?? process.env.Path].filter(Boolean).join(delimiter);

      const result = runWindowsHook(command, {
        PASEO_TERMINAL_ID: "test-terminal",
        PASEO_HOOK_TEST_MARKER: marker,
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        PATH: path,
      });

      expect(result.status).toBe(0);
      expect(readFileSync(marker, "utf8").trim()).toBe("hooks claude UserPromptSubmit");
    });

    it("forwards stdin JSON to the configured CLI for Notification", () => {
      const binDir = createTempDir("paseo-claude-win-stdin-");
      const hookCli = join(binDir, "paseo-stdin.cmd");
      const captureScript = join(binDir, "capture.cjs");
      const argsPath = join(binDir, "args.txt");
      const stdinPath = join(binDir, "stdin.txt");
      const payload = `${JSON.stringify({ message: "ação", notification_type: "idle_prompt" })}\n`;
      writeFileSync(
        captureScript,
        'const { readFileSync, writeFileSync } = require("node:fs"); writeFileSync(process.env.PASEO_HOOK_STDIN, readFileSync(0)); writeFileSync(process.env.PASEO_HOOK_ARGS, process.argv.slice(2).join(" "));',
      );
      writeFileSync(
        hookCli,
        '@echo off\r\n"%PASEO_HOOK_TEST_NODE%" "%PASEO_HOOK_CAPTURE_SCRIPT%" %*\r\nexit /b %ERRORLEVEL%\r\n',
      );
      const command = installedClaudeHookCommand("Notification");

      const result = runWindowsHook(
        command,
        {
          PASEO_TERMINAL_ID: "test-terminal",
          PASEO_HOOK_CLI: hookCli,
          PASEO_HOOK_ARGS: argsPath,
          PASEO_HOOK_CAPTURE_SCRIPT: captureScript,
          PASEO_HOOK_STDIN: stdinPath,
          PASEO_HOOK_TEST_NODE: process.execPath,
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
          PATH: process.env.PATH ?? process.env.Path ?? "",
        },
        payload,
      );

      expect(result.status).toBe(0);
      expect(readFileSync(argsPath, "utf8")).toBe("hooks claude Notification");
      expect(readFileSync(stdinPath)).toEqual(Buffer.from(payload));
    });
  });

  it("keeps provider names out of the generic server bootstrap", () => {
    const source = readFileSync(
      new URL("../../../server/bootstrap.ts", import.meta.url),
      "utf8",
    ).toLowerCase();

    for (const providerId of Object.keys(AGENT_HOOK_PROVIDERS)) {
      expect(source).not.toContain(providerId);
    }
  });

  it("prepends the paseo CLI directory and injects the hook CLI path", () => {
    const cliBinDir = createFakeCliBinDir();
    const hookCliPath = join(cliBinDir, "paseo");

    const env = buildTerminalEnvironment({
      shell: "/bin/sh",
      env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
      paseoCliBinDir: cliBinDir,
      paseoHookCliPath: hookCliPath,
    });

    expect(env.PATH?.split(delimiter)).toEqual([cliBinDir, "/usr/bin", "/bin"]);
    expect(env.PASEO_HOOK_CLI).toBe(hookCliPath);
  });

  it("leaves terminal PATH unchanged when the CLI directory cannot be resolved", () => {
    const env = buildTerminalEnvironment({
      shell: "/bin/sh",
      env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
      paseoCliBinDir: null,
    });

    expect(env.PATH?.split(delimiter)).toEqual(["/usr/bin", "/bin"]);
  });
});
