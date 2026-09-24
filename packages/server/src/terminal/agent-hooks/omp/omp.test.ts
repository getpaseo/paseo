import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  resolveAgentHookConfigPath,
} from "../agent-hook-installer.js";
import { OMP_HOOK_SOURCE, ompAgentHookProvider } from "./omp.js";

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

type Handler = (event: { toolName?: string }, ctx: { hasUI: boolean }) => void;
type HookFactory = (pi: { on(event: string, handler: Handler): void }) => void;

function loadInstalledHook(env: Record<string, string>, exited = Promise.resolve(0)) {
  const configDir = createTempDir("paseo-omp-runtime-");
  const { configPath } = installAgentHooks(ompAgentHookProvider, { configDir });
  const commands: string[][] = [];
  // Supply the host runtime at the script boundary; execute the installed source.
  const factory: HookFactory = runInNewContext(
    readFileSync(configPath, "utf8").replace("export default", "globalThis.factory ="),
    {
      process: { env },
      Bun: {
        spawn(command: string[]) {
          commands.push(command);
          return { exited };
        },
      },
    },
  );
  const handlers = new Map<string, Handler>();
  factory({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (event: string, hasUI: boolean, toolName?: string) =>
    handlers.get(event)?.({ toolName }, { hasUI });
  return { commands, emit, handlers };
}

const TERMINAL_ENV = { PASEO_TERMINAL_ID: "terminal-1", PASEO_HOOK_CLI: "/opt/paseo" };

describe("omp terminal agent hooks", () => {
  it("installs the hook factory idempotently under the omp agent dir", () => {
    const homeDir = createTempDir("paseo-home-");
    const first = installAgentHooks(ompAgentHookProvider, { env: {}, homeDir });
    const second = installAgentHooks(ompAgentHookProvider, { env: {}, homeDir });

    expect(first.configPath).toBe(
      join(homeDir, ".omp", "agent", "hooks", "post", "paseo-terminal-activity.js"),
    );
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(readFileSync(first.configPath, "utf8")).toBe(OMP_HOOK_SOURCE);
    expect(agentHooksAreInstalled(ompAgentHookProvider, { env: {}, homeDir })).toBe(true);
  });

  it("prefers PI_CODING_AGENT_DIR over the home agent dir", () => {
    const agentDir = createTempDir("paseo-omp-agent-");
    const configPath = resolveAgentHookConfigPath(ompAgentHookProvider, {
      env: { PI_CODING_AGENT_DIR: agentDir },
      homeDir: createTempDir("paseo-home-"),
    });

    expect(configPath).toBe(join(agentDir, "hooks", "post", "paseo-terminal-activity.js"));
  });

  it("reports the interactive turn and ask prompt in order", async () => {
    const { commands, emit } = loadInstalledHook(TERMINAL_ENV);
    emit("agent_start", true);
    emit("tool_call", true, "read");
    emit("tool_call", true, "ask");
    emit("tool_result", true, "ask");
    emit("agent_end", true);
    await flush();

    expect(commands).toEqual([
      ["/opt/paseo", "hooks", "omp", "agent_start"],
      ["/opt/paseo", "hooks", "omp", "ask.started"],
      ["/opt/paseo", "hooks", "omp", "ask.finished"],
      ["/opt/paseo", "hooks", "omp", "agent_end"],
    ]);
  });

  it("ignores subagent sessions, which run without UI", async () => {
    const { commands, emit } = loadInstalledHook(TERMINAL_ENV);
    emit("agent_start", false);
    emit("tool_call", false, "ask");
    emit("agent_end", false);
    await flush();

    expect(commands).toEqual([]);
  });

  it("waits for each report before spawning the next", async () => {
    const firstExit = Promise.withResolvers<number>();
    const { commands, emit } = loadInstalledHook(TERMINAL_ENV, firstExit.promise);
    emit("agent_start", true);
    emit("agent_end", true);
    await flush();
    expect(commands).toEqual([["/opt/paseo", "hooks", "omp", "agent_start"]]);

    firstExit.resolve(0);
    await flush();
    expect(commands).toEqual([
      ["/opt/paseo", "hooks", "omp", "agent_start"],
      ["/opt/paseo", "hooks", "omp", "agent_end"],
    ]);
  });

  it("registers nothing outside Paseo terminals", () => {
    const { handlers } = loadInstalledHook({});

    expect(handlers.size).toBe(0);
  });

  it.each([
    ["agent_start", "running"],
    ["agent_end", "idle"],
    ["ask.started", "needs-input"],
    ["ask.finished", "running"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      ompAgentHookProvider.resolveActivity({ event, input: { read: async () => null } }),
    ).resolves.toBe(state);
  });
});
