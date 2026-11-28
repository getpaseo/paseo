import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPlatform } from "../../../test-utils/platform.js";
import {
  agentHooksAreInstalled,
  buildAgentHookWindowsCommand,
  installAgentHooks,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { codexAgentHookProvider } from "./codex.js";

const temporaryDirs: string[] = [];
const powershellHosts = [
  { shell: "powershell.exe", available: isPlatform("win32") },
  {
    shell: "pwsh.exe",
    available:
      isPlatform("win32") &&
      spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
        windowsHide: true,
        timeout: 10000,
      }).status === 0,
  },
];
const hookExitCases = codexAgentHookProvider.events.flatMap(({ event }) =>
  [0, 7].map((exitCode) => ({ event, exitCode })),
);

function hookEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PASEO_TERMINAL_ID;
  delete env.PASEO_HOOK_CLI;
  return env;
}

function prependHookPath(env: NodeJS.ProcessEnv, hookDir: string): void {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${hookDir}${delimiter}${env[pathKey] ?? ""}`;
}

function runPowerShellHook(
  shell: string,
  event: { event: string },
  env: NodeJS.ProcessEnv,
  input = "{}",
) {
  const command = buildAgentHookWindowsCommand(codexAgentHookProvider, event);
  return spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", `${command}; exit $LASTEXITCODE`],
    { env, input, encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
}

function createHookCliFixture(hookDir: string): { hookCli: string; capture: string } {
  const hookCli = join(hookDir, "paseo hook.cmd");
  const script = join(hookDir, "capture.cjs");
  const capture = join(hookDir, "capture.json");
  writeFileSync(
    script,
    "const fs = require('node:fs'); " +
      "fs.writeFileSync(process.env.HOOK_CAPTURE, JSON.stringify({args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8')})); " +
      "process.exit(Number(process.env.HOOK_EXIT));\n",
  );
  writeFileSync(
    hookCli,
    `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`,
  );
  return { hookCli, capture };
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface TestCodexHooksFile {
  hooks?: Record<string, unknown>;
}

interface TestCodexCommandHook {
  command?: string;
  commandWindows?: string;
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function readHooksFile(configDir: string): TestCodexHooksFile {
  return JSON.parse(readFileSync(join(configDir, "hooks.json"), "utf8")) as TestCodexHooksFile;
}

function commandHooks(config: TestCodexHooksFile, event: string): TestCodexCommandHook[] {
  const entries = config.hooks?.[event];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      return [];
    }
    return entry.hooks.filter(isRecord).map((hook) => ({
      command: typeof hook.command === "string" ? hook.command : undefined,
      commandWindows: typeof hook.commandWindows === "string" ? hook.commandWindows : undefined,
    }));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("Codex terminal agent hooks", () => {
  it("installs POSIX and Windows hook commands idempotently", () => {
    const configDir = createTempDir("paseo-codex-config-");

    installAgentHooks(codexAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(codexAgentHookProvider, { configDir });

    const config = readHooksFile(configDir);
    for (const event of codexAgentHookProvider.events) {
      expect(commandHooks(config, event.event)).toEqual([
        {
          command: `if [ -n "$PASEO_TERMINAL_ID" ]; then "\${PASEO_HOOK_CLI:-paseo}" hooks codex ${event.event}; fi`,
          commandWindows: buildAgentHookWindowsCommand(codexAgentHookProvider, event),
        },
      ]);
    }
    expect(secondInstall.changed).toBe(false);
    expect(agentHooksAreInstalled(codexAgentHookProvider, { configDir })).toBe(true);
  });

  it("builds a quote-free Windows hook command", () => {
    const event = codexAgentHookProvider.events[0];
    const command = buildAgentHookWindowsCommand(codexAgentHookProvider, event);
    const prefix = "powershell.exe -NoProfile -NonInteractive -EncodedCommand ";

    expect(command.startsWith(prefix)).toBe(true);
    expect(command).not.toContain('"');

    const encodedScript = command.slice(prefix.length);
    expect(Buffer.from(encodedScript, "base64").toString("utf16le")).toBe(
      [
        "if ([string]::IsNullOrEmpty($env:PASEO_TERMINAL_ID)) { exit 0 }",
        "$hookCli = $env:PASEO_HOOK_CLI",
        "if ([string]::IsNullOrEmpty($hookCli)) { $hookCli = 'paseo' }",
        "& $hookCli 'hooks' 'codex' 'UserPromptSubmit'",
        "$hookSucceeded = $?",
        "$hookExitCode = $LASTEXITCODE",
        "if ($hookSucceeded) { if ($null -ne $hookExitCode) { exit $hookExitCode }; exit 0 }",
        "if ($null -ne $hookExitCode) { exit $hookExitCode }",
        "exit 1",
      ].join("\n"),
    );
  });

  it.each(["commandWindows", "command_windows"] as const)(
    "reports legacy %s hooks as outdated and upgrades them without losing user hooks",
    (windowsField) => {
      const configDir = createTempDir("paseo-codex-legacy-hooks-");
      const hooks = Object.fromEntries(
        codexAgentHookProvider.events.map(({ event }) => [
          event,
          [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "user-notification", timeout: 5 },
                {
                  type: "command",
                  command: `if [ -n "$PASEO_TERMINAL_ID" ]; then "\${PASEO_HOOK_CLI:-paseo}" hooks codex ${event}; fi`,
                  [windowsField]: `if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" hooks codex ${event}) else (paseo hooks codex ${event})) else (exit /b 0)`,
                  timeout: 10,
                },
              ],
            },
          ],
        ]),
      );
      writeFileSync(join(configDir, "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);

      expect(agentHooksAreInstalled(codexAgentHookProvider, { configDir })).toBe(false);
      expect(installAgentHooks(codexAgentHookProvider, { configDir }).changed).toBe(true);
      expect(agentHooksAreInstalled(codexAgentHookProvider, { configDir })).toBe(true);
      expect(installAgentHooks(codexAgentHookProvider, { configDir }).changed).toBe(false);
      for (const event of codexAgentHookProvider.events) {
        expect(commandHooks(readHooksFile(configDir), event.event)).toEqual([
          { command: "user-notification", commandWindows: undefined },
          {
            command: `if [ -n "$PASEO_TERMINAL_ID" ]; then "\${PASEO_HOOK_CLI:-paseo}" hooks codex ${event.event}; fi`,
            commandWindows: buildAgentHookWindowsCommand(codexAgentHookProvider, event),
          },
        ]);
      }
    },
  );

  it.skipIf(!isPlatform("win32")).each(codexAgentHookProvider.events)(
    "$event Windows hook command exits 0 without a Paseo terminal through Codex's cmd wrapper",
    (event) => {
      const command = buildAgentHookWindowsCommand(codexAgentHookProvider, event);
      const env = { ...process.env };
      delete env.PASEO_TERMINAL_ID;
      delete env.PASEO_HOOK_CLI;

      const result = spawnSync(
        process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
        ["/d", "/s", "/c", `"${command}"`],
        {
          env,
          stdio: "ignore",
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    },
  );

  it.skipIf(!isPlatform("win32"))(
    "runs a PASEO_HOOK_CLI cmd shim through Codex's cmd wrapper",
    () => {
      const hookDir = createTempDir("paseo-codex-hook-cli-");
      const hookCli = join(hookDir, "paseo hook.cmd");
      const outputPath = join(hookDir, "hook-output.txt");
      writeFileSync(hookCli, `@echo off\r\necho %* > "${outputPath}"\r\nexit /b 0\r\n`);

      const command = buildAgentHookWindowsCommand(
        codexAgentHookProvider,
        codexAgentHookProvider.events[0],
      );
      const result = spawnSync(
        process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
        ["/d", "/s", "/c", `"${command}"`],
        {
          env: {
            ...process.env,
            PASEO_TERMINAL_ID: "paseo-codex-terminal",
            PASEO_HOOK_CLI: hookCli,
          },
          stdio: "ignore",
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(outputPath, "utf8").trim()).toBe("hooks codex UserPromptSubmit");
    },
  );

  for (const { shell, available } of powershellHosts) {
    describe.skipIf(!available)(`${shell} hook host`, () => {
      it.each(codexAgentHookProvider.events)(
        "$event exits successfully and silently outside Paseo",
        (event) => {
          const result = runPowerShellHook(shell, event, hookEnvironment());
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("");
        },
      );

      it.each(hookExitCases)(
        "$event forwards stdin to a spaced CLI path and preserves exit $exitCode",
        (event) => {
          const hookDir = createTempDir("paseo codex hook cli ");
          const { hookCli, capture } = createHookCliFixture(hookDir);
          const input = JSON.stringify({ fixture: "x".repeat(50000) });
          const result = runPowerShellHook(
            shell,
            event,
            {
              ...hookEnvironment(),
              PASEO_TERMINAL_ID: "fixture-terminal",
              PASEO_HOOK_CLI: hookCli,
              HOOK_CAPTURE: capture,
              HOOK_EXIT: String(event.exitCode),
            },
            input,
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(event.exitCode);
          expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
            args: ["hooks", "codex", event.event],
            input,
          });
        },
      );

      it("finds the Paseo CLI on PATH when no override is supplied", () => {
        const hookDir = createTempDir("paseo codex hook fallback ");
        const { hookCli, capture } = createHookCliFixture(hookDir);
        writeFileSync(join(hookDir, "paseo.cmd"), readFileSync(hookCli));
        const env = hookEnvironment();
        prependHookPath(env, hookDir);
        const result = runPowerShellHook(
          shell,
          { event: "Stop" },
          {
            ...env,
            PASEO_TERMINAL_ID: "fixture-terminal",
            HOOK_CAPTURE: capture,
            HOOK_EXIT: "0",
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
          args: ["hooks", "codex", "Stop"],
          input: "{}",
        });
      });

      it("reports a missing CLI in an active Paseo terminal", () => {
        const result = runPowerShellHook(
          shell,
          { event: "Stop" },
          {
            ...hookEnvironment(),
            PASEO_TERMINAL_ID: "fixture-terminal",
            PASEO_HOOK_CLI: join(createTempDir("paseo missing hook cli "), "missing.cmd"),
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
      });
    });
  }

  it("preserves unrelated user hooks", () => {
    const configDir = createTempDir("paseo-codex-config-preserve-");
    writeFileSync(
      join(configDir, "hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "say codex done", timeout: 5 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    installAgentHooks(codexAgentHookProvider, { configDir });

    const stopCommands = commandHooks(readHooksFile(configDir), "Stop").map((hook) => hook.command);
    expect(stopCommands).toEqual([
      "say codex done",
      'if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo}" hooks codex Stop; fi',
    ]);
  });

  it("uninstalls only marker-matched hooks", () => {
    const configDir = createTempDir("paseo-codex-config-uninstall-");
    installAgentHooks(codexAgentHookProvider, { configDir });
    const config = readHooksFile(configDir);
    config.hooks = {
      ...config.hooks,
      Stop: [
        ...(Array.isArray(config.hooks?.Stop) ? config.hooks.Stop : []),
        {
          matcher: "",
          hooks: [{ type: "command", command: "say still-here", timeout: 5 }],
        },
      ],
    };
    writeFileSync(join(configDir, "hooks.json"), `${JSON.stringify(config, null, 2)}\n`);

    uninstallAgentHooks(codexAgentHookProvider, { configDir });

    expect(commandHooks(readHooksFile(configDir), "Stop").map((hook) => hook.command)).toEqual([
      "say still-here",
    ]);
    expect(agentHooksAreInstalled(codexAgentHookProvider, { configDir })).toBe(false);
  });

  it.each([
    ["UserPromptSubmit", "running"],
    ["PreToolUse", "running"],
    ["PostToolUse", "running"],
    ["PermissionRequest", "needs-input"],
    ["Stop", "idle"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      codexAgentHookProvider.resolveActivity({
        event,
        input: { read: async () => null },
      }),
    ).resolves.toBe(state);
  });
});
