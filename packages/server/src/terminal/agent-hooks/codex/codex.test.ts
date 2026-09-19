import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
