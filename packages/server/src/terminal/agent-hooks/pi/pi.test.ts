import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  resolveAgentHookConfigPath,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { PI_EXTENSION_SOURCE } from "./pi-extension.js";
import { piAgentHookProvider } from "./pi.js";

const temporaryDirs: string[] = [];
let extensionModuleId = 0;

afterEach(() => {
  vi.useRealTimers();
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

interface FakeContext {
  mode: "tui" | "rpc";
  isIdle(): boolean;
  sessionManager: {
    getBranch(): unknown[];
  };
}

interface FakeExtensionApi {
  on(event: string, handler: (event: unknown, ctx: FakeContext) => void): void;
}

function createFakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: FakeContext) => void>>();
  const pi: FakeExtensionApi = {
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
  };
  return {
    pi,
    emit(event: string, payload: unknown, ctx: FakeContext) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload, ctx);
      }
    },
  };
}

function createContext(options?: {
  mode?: "tui" | "rpc";
  idle?: boolean;
  entries?: unknown[];
}): FakeContext {
  return {
    mode: options?.mode ?? "tui",
    isIdle: () => options?.idle ?? true,
    sessionManager: {
      getBranch: () => options?.entries ?? [],
    },
  };
}

function goalEntry(status: string, options?: { queued?: boolean; pending?: boolean }) {
  return {
    type: "custom",
    customType: "goal-state",
    data: {
      goal: { status },
      ...(options?.queued ? { queue: [{ status: "queued" }] } : {}),
      ...(options?.pending ? { pendingAction: { kind: "advance" } } : {}),
    },
  };
}

async function loadExtension() {
  const dir = createTempDir("paseo-pi-extension-runtime-");
  const extensionPath = join(dir, "paseo-terminal-activity.mjs");
  writeFileSync(extensionPath, PI_EXTENSION_SOURCE);
  const extension = await import(
    `${pathToFileURL(extensionPath).href}?test=${extensionModuleId++}`
  );
  vi.useFakeTimers();
  return extension as {
    registerPaseoTerminalActivity(
      pi: FakeExtensionApi,
      options: {
        env: NodeJS.ProcessEnv;
        report: (event: string) => void;
        settleDelayMs: number;
      },
    ): void;
  };
}

function paseoEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PASEO_TERMINAL_ID: "terminal-1",
    PASEO_ACTIVITY_TOKEN: "token-1",
    PASEO_TERMINAL_ACTIVITY_URL: "http://127.0.0.1:6767/api/terminal-activity",
    PASEO_HOOK_CLI: "/tmp/paseo",
    ...overrides,
  };
}

async function flushSettleTimer(): Promise<void> {
  await vi.runAllTimersAsync();
}

describe("Pi terminal agent hooks", () => {
  it("installs and uninstalls the Pi extension idempotently", () => {
    const agentDir = createTempDir("paseo-pi-agent-dir-");

    const firstInstall = installAgentHooks(piAgentHookProvider, { configDir: agentDir });
    const secondInstall = installAgentHooks(piAgentHookProvider, { configDir: agentDir });

    expect(firstInstall.configPath).toBe(
      join(agentDir, "extensions", "paseo-terminal-activity.ts"),
    );
    expect(firstInstall.changed).toBe(true);
    expect(secondInstall.changed).toBe(false);
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe(PI_EXTENSION_SOURCE);
    expect(agentHooksAreInstalled(piAgentHookProvider, { configDir: agentDir })).toBe(true);

    const uninstall = uninstallAgentHooks(piAgentHookProvider, { configDir: agentDir });
    expect(uninstall).toEqual({ configPath: firstInstall.configPath, changed: true });
    expect(existsSync(firstInstall.configPath)).toBe(false);
  });

  it("matches Pi path resolution for custom agent directories", () => {
    const homeDir = createTempDir("paseo-pi-home-");
    const cwd = createTempDir("paseo-pi-cwd-");
    const absoluteDir = createTempDir("paseo-pi-agent-absolute-");
    const extensionPath = join("extensions", "paseo-terminal-activity.ts");

    expect(
      resolveAgentHookConfigPath(piAgentHookProvider, {
        env: { PI_CODING_AGENT_DIR: absoluteDir },
        homeDir,
        cwd,
      }),
    ).toBe(join(absoluteDir, extensionPath));
    expect(
      resolveAgentHookConfigPath(piAgentHookProvider, {
        env: { PI_CODING_AGENT_DIR: "~/pi-agent" },
        homeDir,
        cwd,
      }),
    ).toBe(join(homeDir, "pi-agent", extensionPath));
    expect(
      resolveAgentHookConfigPath(piAgentHookProvider, {
        env: { PI_CODING_AGENT_DIR: "./pi-agent" },
        homeDir,
        cwd,
      }),
    ).toBe(join(cwd, "pi-agent", extensionPath));
  });

  it.each([
    ["agent_start", "running"],
    ["agent_settled", "idle"],
    ["needs_input", "needs-input"],
    ["resume", "running"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      piAgentHookProvider.resolveActivity({ event, input: { read: async () => null } }),
    ).resolves.toBe(state);
  });

  it("reports one running-to-idle lifecycle after Pi fully settles", async () => {
    const extension = await loadExtension();
    const runtime = createFakePi();
    const events: string[] = [];
    const ctx = createContext();
    extension.registerPaseoTerminalActivity(runtime.pi, {
      env: paseoEnv(),
      report: (event) => events.push(event),
      settleDelayMs: 0,
    });

    runtime.emit("session_start", { reason: "startup" }, ctx);
    runtime.emit("agent_start", {}, ctx);
    runtime.emit("agent_settled", {}, ctx);
    runtime.emit("agent_settled", {}, ctx);
    await flushSettleTimer();

    expect(events).toEqual(["agent_start", "agent_settled"]);
  });

  it("keeps an automatically continuing Goal running without a false completion", async () => {
    const extension = await loadExtension();
    const runtime = createFakePi();
    const events: string[] = [];
    let idle = true;
    const activeGoalContext = createContext({ entries: [goalEntry("active")] });
    activeGoalContext.isIdle = () => idle;
    extension.registerPaseoTerminalActivity(runtime.pi, {
      env: paseoEnv(),
      report: (event) => events.push(event),
      settleDelayMs: 0,
    });

    runtime.emit("session_start", { reason: "startup" }, activeGoalContext);
    runtime.emit("agent_start", {}, activeGoalContext);
    runtime.emit("agent_settled", {}, activeGoalContext);
    idle = false;
    await flushSettleTimer();

    expect(events).toEqual(["agent_start"]);
  });

  it("reports an active Goal that remains idle as needing input", async () => {
    const extension = await loadExtension();
    const runtime = createFakePi();
    const events: string[] = [];
    const activeGoalContext = createContext({ entries: [goalEntry("active")] });
    extension.registerPaseoTerminalActivity(runtime.pi, {
      env: paseoEnv(),
      report: (event) => events.push(event),
      settleDelayMs: 0,
    });

    runtime.emit("session_start", { reason: "startup" }, activeGoalContext);
    runtime.emit("agent_start", {}, activeGoalContext);
    runtime.emit("agent_settled", {}, activeGoalContext);
    await flushSettleTimer();

    expect(events).toEqual(["agent_start", "needs_input"]);
  });

  it.each(["paused", "blocked", "usage_limited", "budget_limited"])(
    "reports a stopped %s Goal as needing input",
    async (status) => {
      const extension = await loadExtension();
      const runtime = createFakePi();
      const events: string[] = [];
      const runningContext = createContext();
      const stoppedGoalContext = createContext({ entries: [goalEntry(status)] });
      extension.registerPaseoTerminalActivity(runtime.pi, {
        env: paseoEnv(),
        report: (event) => events.push(event),
        settleDelayMs: 0,
      });

      runtime.emit("session_start", { reason: "startup" }, runningContext);
      runtime.emit("agent_start", {}, runningContext);
      runtime.emit("agent_settled", {}, stoppedGoalContext);
      await flushSettleTimer();

      expect(events).toEqual(["agent_start", "needs_input"]);
    },
  );

  it("reports ask_user waiting and resume before final settlement", async () => {
    const extension = await loadExtension();
    const runtime = createFakePi();
    const events: string[] = [];
    const ctx = createContext();
    extension.registerPaseoTerminalActivity(runtime.pi, {
      env: paseoEnv(),
      report: (event) => events.push(event),
      settleDelayMs: 0,
    });

    runtime.emit("session_start", { reason: "startup" }, ctx);
    runtime.emit("agent_start", {}, ctx);
    runtime.emit("tool_execution_start", { toolName: "ask_user" }, ctx);
    runtime.emit("tool_execution_end", { toolName: "ask_user" }, ctx);
    runtime.emit("agent_settled", {}, ctx);
    await flushSettleTimer();

    expect(events).toEqual(["agent_start", "needs_input", "resume", "agent_settled"]);
  });

  it.each([
    ["RPC mode", paseoEnv(), createContext({ mode: "rpc" })],
    ["a child Pi", paseoEnv({ PI_SUBAGENT_CHILD: "1" }), createContext()],
    ["a non-Paseo terminal", {}, createContext()],
  ])("stays silent in %s", async (_label, env, ctx) => {
    const extension = await loadExtension();
    const runtime = createFakePi();
    const events: string[] = [];
    extension.registerPaseoTerminalActivity(runtime.pi, {
      env,
      report: (event) => events.push(event),
      settleDelayMs: 0,
    });

    runtime.emit("session_start", { reason: "startup" }, ctx);
    runtime.emit("agent_start", {}, ctx);
    runtime.emit("agent_settled", {}, ctx);
    await flushSettleTimer();

    expect(events).toEqual([]);
  });

  it("cancels a pending completion report on session shutdown", async () => {
    const extension = await loadExtension();
    const runtime = createFakePi();
    const events: string[] = [];
    const ctx = createContext();
    extension.registerPaseoTerminalActivity(runtime.pi, {
      env: paseoEnv(),
      report: (event) => events.push(event),
      settleDelayMs: 0,
    });

    runtime.emit("session_start", { reason: "startup" }, ctx);
    runtime.emit("agent_start", {}, ctx);
    runtime.emit("agent_settled", {}, ctx);
    runtime.emit("session_shutdown", { reason: "quit" }, ctx);
    await flushSettleTimer();

    expect(events).toEqual(["agent_start"]);
  });
});
