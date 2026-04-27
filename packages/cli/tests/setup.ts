/**
 * Test setup utilities for Hubcode CLI E2E tests
 *
 * Critical rules from design doc:
 * 1. Port: Random port via 10000 + Math.floor(Math.random() * 50000) - NEVER 6767
 * 2. Protocol: WebSocket ONLY - daemon has no HTTP endpoints
 * 3. Temp dirs: Create temp directories for HUBCODE_HOME and agent --cwd
 * 4. Model: Always --provider claude with haiku model for agent tests
 * 5. Cleanup: Kill daemon and remove temp dirs after each test
 */

import { $, ProcessPromise, sleep } from "zx";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const TEST_ENV_DEFAULTS = {
  HUBCODE_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.HUBCODE_LOCAL_SPEECH_AUTO_DOWNLOAD ?? "0",
  HUBCODE_DICTATION_ENABLED: process.env.HUBCODE_DICTATION_ENABLED ?? "0",
  HUBCODE_VOICE_MODE_ENABLED: process.env.HUBCODE_VOICE_MODE_ENABLED ?? "0",
};

function killPidTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return;
      }
    }
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

export interface TestContext {
  /** Random port for test daemon (never 6767) */
  port: number;
  /** Temp directory for HUBCODE_HOME */
  hubcodeHome: string;
  /** Temp directory for agent working directory */
  workDir: string;
  /** Running daemon process */
  daemon: ProcessPromise | null;
  /** Run a hubcode CLI command against the test daemon */
  hubcode: (args: string[]) => ProcessPromise;
  /** Clean up all resources */
  cleanup: () => Promise<void>;
}

/**
 * Generate a random port for test daemon
 * NEVER uses 6767 (user's running daemon)
 */
export function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/**
 * Create isolated temp directories for testing
 */
export async function createTempDirs(): Promise<{ hubcodeHome: string; workDir: string }> {
  const hubcodeHome = await mkdtemp(join(tmpdir(), "hubcode-test-home-"));
  const workDir = await mkdtemp(join(tmpdir(), "hubcode-test-work-"));
  return { hubcodeHome, workDir };
}

/**
 * Wait for daemon to be ready by testing WebSocket connection
 * Uses `hubcode agent ls` which connects via WebSocket
 */
async function probeDaemon(port: number): Promise<boolean> {
  try {
    const result = await $`HUBCODE_HOST=localhost:${port} hubcode agent ls`.nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function waitForDaemon(port: number, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  async function poll(): Promise<void> {
    if (await probeDaemon(port)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Daemon failed to start on port ${port} within ${timeout}ms`);
    }
    await sleep(100);
    return poll();
  }
  return poll();
}

/**
 * Start an isolated test daemon
 */
export async function startDaemon(port: number, hubcodeHome: string): Promise<ProcessPromise> {
  $.verbose = false;
  const daemon =
    $`HUBCODE_HOME=${hubcodeHome} HUBCODE_LISTEN=127.0.0.1:${port} HUBCODE_RELAY_ENABLED=false HUBCODE_LOCAL_SPEECH_AUTO_DOWNLOAD=${TEST_ENV_DEFAULTS.HUBCODE_LOCAL_SPEECH_AUTO_DOWNLOAD} HUBCODE_DICTATION_ENABLED=${TEST_ENV_DEFAULTS.HUBCODE_DICTATION_ENABLED} HUBCODE_VOICE_MODE_ENABLED=${TEST_ENV_DEFAULTS.HUBCODE_VOICE_MODE_ENABLED} CI=true hubcode daemon start --foreground`.nothrow();
  return daemon;
}

/**
 * Create a full test context with daemon, temp dirs, and helpers
 */
export async function createTestContext(): Promise<TestContext> {
  const port = getRandomPort();
  const { hubcodeHome, workDir } = await createTempDirs();

  // Helper to run CLI commands against test daemon
  const hubcode = (args: string[]): ProcessPromise => {
    $.verbose = false;
    return $`HUBCODE_HOST=localhost:${port} HUBCODE_LOCAL_SPEECH_AUTO_DOWNLOAD=${TEST_ENV_DEFAULTS.HUBCODE_LOCAL_SPEECH_AUTO_DOWNLOAD} HUBCODE_DICTATION_ENABLED=${TEST_ENV_DEFAULTS.HUBCODE_DICTATION_ENABLED} HUBCODE_VOICE_MODE_ENABLED=${TEST_ENV_DEFAULTS.HUBCODE_VOICE_MODE_ENABLED} hubcode ${args}`.nothrow();
  };

  // Cleanup function
  const cleanup = async (): Promise<void> => {
    if (ctx.daemon) {
      if (typeof ctx.daemon.pid === "number") {
        killPidTree(ctx.daemon.pid, "SIGTERM");
        await sleep(250);
        killPidTree(ctx.daemon.pid, "SIGKILL");
      } else {
        ctx.daemon.kill();
      }
    }
    await rm(hubcodeHome, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  };

  const ctx: TestContext = {
    port,
    hubcodeHome,
    workDir,
    daemon: null,
    hubcode,
    cleanup,
  };

  return ctx;
}

/**
 * Create a test context and start the daemon
 * Use this for tests that need a running daemon
 */
export async function createTestContextWithDaemon(): Promise<TestContext> {
  const ctx = await createTestContext();
  ctx.daemon = await startDaemon(ctx.port, ctx.hubcodeHome);
  await waitForDaemon(ctx.port);
  return ctx;
}

/**
 * Register cleanup handlers for process exit
 */
export function registerCleanupHandlers(cleanup: () => Promise<void>): void {
  const handler = async () => {
    await cleanup();
    process.exit(0);
  };

  process.on("exit", () => {
    // Can't await in exit handler, but at least try to kill daemon
  });
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
