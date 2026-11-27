import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { antigravityAgentHookProvider } from "./antigravity.js";

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

function readHooksFile(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, "hooks.json"), "utf8")) as Record<string, unknown>;
}

describe("Antigravity terminal agent hooks", () => {
  it("installs flat and tool-grouped hooks idempotently under paseo-terminal-activity", () => {
    const configDir = createTempDir("paseo-antigravity-config-");

    installAgentHooks(antigravityAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(antigravityAgentHookProvider, { configDir });

    const config = readHooksFile(configDir);
    const entry = config["paseo-terminal-activity"] as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(Array.isArray(entry.PreInvocation)).toBe(true);
    expect(Array.isArray(entry.Stop)).toBe(true);
    expect(entry.PostToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          expect.objectContaining({
            type: "command",
            command: expect.stringContaining("hooks antigravity PostToolUse"),
            timeout: 10,
          }),
        ],
      },
    ]);
    expect(secondInstall.changed).toBe(false);
    expect(agentHooksAreInstalled(antigravityAgentHookProvider, { configDir })).toBe(true);
  });

  it("preserves unrelated user hooks on install and uninstall", () => {
    const configDir = createTempDir("paseo-antigravity-preserve-");
    writeFileSync(
      join(configDir, "hooks.json"),
      `${JSON.stringify(
        {
          "lint-checker": {
            PostToolUse: [
              {
                matcher: "run_command",
                hooks: [{ type: "command", command: "./scripts/lint.sh", timeout: 10 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    installAgentHooks(antigravityAgentHookProvider, { configDir });
    expect(readHooksFile(configDir)["lint-checker"]).toBeDefined();
    expect(agentHooksAreInstalled(antigravityAgentHookProvider, { configDir })).toBe(true);

    uninstallAgentHooks(antigravityAgentHookProvider, { configDir });
    const afterUninstall = readHooksFile(configDir);
    expect(afterUninstall["paseo-terminal-activity"]).toBeUndefined();
    expect(afterUninstall["lint-checker"]).toEqual({
      PostToolUse: [
        {
          matcher: "run_command",
          hooks: [{ type: "command", command: "./scripts/lint.sh", timeout: 10 }],
        },
      ],
    });
    expect(agentHooksAreInstalled(antigravityAgentHookProvider, { configDir })).toBe(false);
  });

  it.each([
    ["PreInvocation", "running"],
    ["PostToolUse", "running"],
    ["Stop", "idle"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      antigravityAgentHookProvider.resolveActivity({
        event,
        input: { read: async () => null },
      }),
    ).resolves.toBe(state);
  });
});
