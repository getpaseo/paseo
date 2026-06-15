import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
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
          command: `[ -n "$PASEO_TERMINAL_ID" ] && "\${PASEO_HOOK_CLI:-paseo}" hooks codex ${event.event}`,
          commandWindows: `if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" hooks codex ${event.event}) else (paseo hooks codex ${event.event}))`,
        },
      ]);
    }
    expect(secondInstall.changed).toBe(false);
    expect(agentHooksAreInstalled(codexAgentHookProvider, { configDir })).toBe(true);
  });

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
      '[ -n "$PASEO_TERMINAL_ID" ] && "${PASEO_HOOK_CLI:-paseo}" hooks codex Stop',
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
