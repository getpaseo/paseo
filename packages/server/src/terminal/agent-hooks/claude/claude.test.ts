import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildTerminalEnvironment } from "../../terminal.js";
import { buildAgentHookShellCommand } from "../agent-hook-installer.js";
import {
  AGENT_HOOK_PROVIDERS,
  installRegisteredAgentHooks,
  registeredAgentHooksAreInstalled,
  uninstallRegisteredAgentHooks,
} from "../provider-registry.js";

const temporaryDirs: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

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

describe("Claude terminal agent hooks", () => {
  it("installs registered provider hooks idempotently", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const install = provider.install;

    installRegisteredAgentHooks({ configDir });
    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    for (const event of provider.events) {
      const paseoCommands = hookCommands(settings, event.event).filter((command) =>
        command.includes(install.hookMarker),
      );
      expect(paseoCommands).toHaveLength(1);
      expect(paseoCommands[0]).toBe(
        `[ -n "$PASEO_TERMINAL_ID" ] && "\${PASEO_HOOK_CLI:-paseo}" hooks ${provider.id} ${event.event}`,
      );
    }
    expect(registeredAgentHooksAreInstalled({ configDir })).toBe(true);
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
    expect(hookCommands(settings, "Stop")).toContain("say done");
    expect(
      hookCommands(settings, "Stop").some((command) => command.includes("hooks claude Stop")),
    ).toBe(true);
  });

  it("uninstalls only marker-matched hooks", () => {
    const configDir = createTempDir("paseo-claude-config-uninstall-");
    installRegisteredAgentHooks({ configDir });
    const settings = readSettings(configDir);
    settings.hooks = {
      ...settings.hooks,
      Stop: [
        ...(Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : []),
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
      '[ -n "$PASEO_TERMINAL_ID" ] && "${PASEO_HOOK_CLI:-paseo}" hooks claude UserPromptSubmit',
    );
  });

  it("keeps provider names out of generic CLI and bootstrap integration points", () => {
    const genericFiles = [
      join(repositoryRoot, "packages", "cli", "src", "commands", "hooks.ts"),
      join(repositoryRoot, "packages", "server", "src", "server", "bootstrap.ts"),
    ];

    for (const filePath of genericFiles) {
      const contents = readFileSync(filePath, "utf8").toLowerCase();
      for (const providerId of Object.keys(AGENT_HOOK_PROVIDERS)) {
        expect(contents).not.toContain(providerId);
      }
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
