import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { grokAgentHookProvider } from "./grok.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface TestGrokHooksFile {
  hooks?: Record<string, unknown>;
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function hooksPath(configDir: string): string {
  return join(configDir, "hooks", "paseo-terminal-activity.json");
}

function readHooksFile(configDir: string): TestGrokHooksFile {
  return JSON.parse(readFileSync(hooksPath(configDir), "utf8")) as TestGrokHooksFile;
}

function hookCommands(config: TestGrokHooksFile, event: string): string[] {
  const entries = config.hooks?.[event];
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

describe("Grok terminal agent hooks", () => {
  it("installs hooks under GROK_HOME/hooks idempotently", () => {
    const configDir = createTempDir("paseo-grok-config-");

    installAgentHooks(grokAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(grokAgentHookProvider, { configDir });

    const config = readHooksFile(configDir);
    for (const event of grokAgentHookProvider.events) {
      const paseoCommands = hookCommands(config, event.event).filter((command) =>
        command.includes("hooks grok"),
      );
      expect(paseoCommands).toHaveLength(1);
      expect(paseoCommands[0]).toBe(
        `if [ -n "$PASEO_TERMINAL_ID" ]; then "\${PASEO_HOOK_CLI:-paseo}" hooks grok ${event.event}; fi`,
      );
    }
    expect(secondInstall.changed).toBe(false);
    expect(agentHooksAreInstalled(grokAgentHookProvider, { configDir })).toBe(true);
  });

  it("uses GROK_HOME when provided", () => {
    const grokHome = createTempDir("paseo-grok-home-");
    mkdirSync(join(grokHome, "hooks"), { recursive: true });

    installAgentHooks(grokAgentHookProvider, { env: { GROK_HOME: grokHome } });

    expect(agentHooksAreInstalled(grokAgentHookProvider, { env: { GROK_HOME: grokHome } })).toBe(
      true,
    );
    expect(readFileSync(hooksPath(grokHome), "utf8")).toContain("hooks grok");
  });

  it("uninstalls marker-matched hooks from the dedicated file", () => {
    const configDir = createTempDir("paseo-grok-config-uninstall-");
    installAgentHooks(grokAgentHookProvider, { configDir });
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
    writeFileSync(hooksPath(configDir), `${JSON.stringify(config, null, 2)}\n`);

    uninstallAgentHooks(grokAgentHookProvider, { configDir });

    expect(hookCommands(readHooksFile(configDir), "Stop")).toEqual(["say still-here"]);
    expect(agentHooksAreInstalled(grokAgentHookProvider, { configDir })).toBe(false);
  });

  it.each([
    ["UserPromptSubmit", "running"],
    ["PreToolUse", "running"],
    ["PostToolUse", "running"],
    ["Stop", "idle"],
    ["StopFailure", "idle"],
    ["SessionEnd", "idle"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      grokAgentHookProvider.resolveActivity({
        event,
        input: { read: async () => null },
      }),
    ).resolves.toBe(state);
  });

  it("maps idle_prompt notifications to needs-input", async () => {
    await expect(
      grokAgentHookProvider.resolveActivity({
        event: "Notification",
        input: { read: async () => JSON.stringify({ reason: "idle_prompt" }) },
      }),
    ).resolves.toBe("needs-input");
  });

  it("ignores unrelated notifications", async () => {
    await expect(
      grokAgentHookProvider.resolveActivity({
        event: "Notification",
        input: { read: async () => JSON.stringify({ reason: "other" }) },
      }),
    ).resolves.toBeNull();
  });
});
