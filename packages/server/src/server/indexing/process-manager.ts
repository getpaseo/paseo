import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";

/**
 * Manages the long-running `code-review-graph` MCP subprocess.
 *
 * Responsibilities:
 *   - Spawn `code-review-graph serve` once per daemon (stdio MCP server)
 *   - Watch its lifecycle and auto-restart on unexpected exit (with backoff)
 *   - Surface state transitions via events for the IndexingService
 *
 * The actual MCP protocol traffic is handled by the proxy layer in PR3 — this
 * file is intentionally transport-agnostic: it owns the process, not the
 * conversation.
 */

export type CrgProcessPhase = "stopped" | "starting" | "running" | "restarting" | "failed";

export interface CrgProcessState {
  phase: CrgProcessPhase;
  pid?: number;
  startedAt?: number;
  lastExit?: { code: number | null; signal: NodeJS.Signals | null; at: number };
  restartCount: number;
  lastError?: string;
}

export interface CrgSpawnHandle {
  pid: number;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

export interface CrgProcessManagerDeps {
  logger: Logger;
  /** Path to the crg binary (resolved via detector). When null, manager refuses to start. */
  binPath: string | null;
  /** Inject for tests; defaults to node:child_process spawn. */
  spawn?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => CrgSpawnHandle;
  /** Override env passed to the child. Static baseline. */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional overlay resolved at each `start()` call. Merged on top of the
   * static `env`. Used to re-inject config-driven vars (e.g. embedding
   * provider) after user changes without constructing a new manager.
   */
  envOverlay?: () => Record<string, string>;
  /** Initial restart backoff in ms (default 500). */
  initialBackoffMs?: number;
  /** Max backoff before capping (default 30s). */
  maxBackoffMs?: number;
  /** Max consecutive failures before giving up (default 5). */
  maxConsecutiveFailures?: number;
  /** Subcommand args (default `["serve"]` for crg ≥ 2.3.0 — older builds
   *  required `["serve", "--stdio"]` but the flag was removed when fastmcp
   *  became the default transport). */
  args?: string[];
  /** Inject scheduler for tests. Defaults to setTimeout. */
  scheduleRestart?: (fn: () => void, delayMs: number) => { cancel(): void };
  /**
   * Resident Set Size (RSS) ceiling for the subprocess in bytes. When
   * exceeded, the manager kills the child with SIGTERM (then SIGKILL after a
   * grace) so we crash the subprocess gracefully BEFORE the kernel OOM-kills
   * the parent daemon. The crg embedding stage (Xenova/BGE local models)
   * can pull ~1-2GB on a single repo; left unchecked, large monorepos kill
   * the daemon entirely. Tunable via HUBCODE_CRG_MAX_RSS_MB. Default 4096MB.
   */
  maxRssBytes?: number;
  /** Polling interval for RSS monitor (default 5s). */
  rssPollMs?: number;
  /**
   * Inject for tests. Returns the RSS in bytes for the given pid, or null if
   * unavailable. Defaults to a `ps` shell-out (macOS/Linux only).
   */
  rssOf?: (pid: number) => Promise<number | null>;
}

const DEFAULT_INITIAL_BACKOFF = 500;
const DEFAULT_MAX_BACKOFF = 30_000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_ARGS = ["serve"];
const DEFAULT_MAX_RSS_MB = 4096;
const DEFAULT_RSS_POLL_MS = 5_000;
const RSS_KILL_GRACE_MS = 5_000;

interface PendingRestart {
  cancel(): void;
}

export interface CrgProcessManagerEvents {
  state: (state: CrgProcessState) => void;
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
}

export class CrgProcessManager extends EventEmitter {
  private readonly logger: Logger;
  private binPath: string | null;
  private readonly spawnFn: NonNullable<CrgProcessManagerDeps["spawn"]>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly envOverlay: (() => Record<string, string>) | null;
  private readonly initialBackoff: number;
  private readonly maxBackoff: number;
  private readonly maxConsecutiveFailures: number;
  private readonly args: string[];
  private readonly schedule: NonNullable<CrgProcessManagerDeps["scheduleRestart"]>;
  private readonly maxRssBytes: number;
  private readonly rssPollMs: number;
  private readonly rssOf: (pid: number) => Promise<number | null>;

  private state: CrgProcessState = { phase: "stopped", restartCount: 0 };
  private child: CrgSpawnHandle | null = null;
  private pendingRestart: PendingRestart | null = null;
  private consecutiveFailures = 0;
  private intentionalStop = false;
  private rssMonitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CrgProcessManagerDeps) {
    super();
    this.logger = deps.logger.child({ module: "crg-process-manager" });
    this.binPath = deps.binPath;
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.env = deps.env ?? { ...process.env };
    this.envOverlay = deps.envOverlay ?? null;
    this.initialBackoff = deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF;
    this.maxBackoff = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
    this.maxConsecutiveFailures = deps.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
    this.args = deps.args ?? DEFAULT_ARGS;
    this.schedule = deps.scheduleRestart ?? defaultScheduleRestart;
    const envRssMb = Number.parseInt(process.env.HUBCODE_CRG_MAX_RSS_MB ?? "", 10);
    const resolvedRssMb =
      deps.maxRssBytes !== undefined
        ? deps.maxRssBytes / (1024 * 1024)
        : Number.isFinite(envRssMb) && envRssMb > 0
          ? envRssMb
          : DEFAULT_MAX_RSS_MB;
    this.maxRssBytes = Math.round(resolvedRssMb * 1024 * 1024);
    this.rssPollMs = deps.rssPollMs ?? DEFAULT_RSS_POLL_MS;
    this.rssOf = deps.rssOf ?? defaultRssOf;
  }

  getState(): CrgProcessState {
    return { ...this.state };
  }

  /**
   * Update the path to the crg binary. Needed after the user installs crg
   * from the UI mid-session — the original constructor path may have been
   * null (crg wasn't installed at boot), and `start()` would otherwise keep
   * failing with "code-review-graph not installed".
   */
  setBinPath(binPath: string | null): void {
    this.binPath = binPath;
  }

  isRunning(): boolean {
    return this.state.phase === "running";
  }

  /**
   * Return the running child's stdout+stdin, or null when no child exists.
   * The caller must not close these streams themselves — the manager owns
   * their lifecycle. Used by the MCP client to construct a transport.
   */
  getChildStreams(): {
    stdout: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream;
  } | null {
    if (!this.child || !this.child.stdout || !this.child.stdin) return null;
    return { stdout: this.child.stdout, stdin: this.child.stdin };
  }

  /**
   * Clear the consecutive-failure counter. The MCP client calls this after a
   * successful handshake, signalling the process is stable enough that any
   * prior crashes should not count against the failure budget.
   */
  resetFailures(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Start the subprocess. Resolves once spawn returns a pid (does NOT wait
   * for the child to advertise readiness — that is the proxy layer's job).
   * Calling `start` while running is a no-op.
   */
  start(): void {
    if (this.state.phase === "running" || this.state.phase === "starting") {
      return;
    }
    if (!this.binPath) {
      this.transition({
        phase: "failed",
        restartCount: this.state.restartCount,
        lastError: "code-review-graph not installed",
      });
      return;
    }
    this.intentionalStop = false;
    this.cancelPendingRestart();
    this.transition({ phase: "starting", restartCount: this.state.restartCount });
    try {
      const overlay = this.envOverlay ? this.envOverlay() : {};
      const effectiveEnv = { ...this.env, ...overlay };
      const child = this.spawnFn(this.binPath, this.args, effectiveEnv);
      this.attachChild(child);
      this.transition({
        phase: "running",
        pid: child.pid,
        startedAt: Date.now(),
        restartCount: this.state.restartCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, "Failed to spawn code-review-graph");
      this.transition({
        phase: "failed",
        restartCount: this.state.restartCount,
        lastError: message,
      });
    }
  }

  /**
   * Stop the subprocess (no auto-restart). Idempotent.
   */
  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.intentionalStop = true;
    this.cancelPendingRestart();
    if (this.child) {
      try {
        this.child.kill(signal);
      } catch (err) {
        this.logger.warn({ err }, "kill(crg) failed");
      }
    }
    this.transition({ phase: "stopped", restartCount: this.state.restartCount });
    this.child = null;
  }

  /**
   * Hard restart: stop then start. Resets failure counter.
   */
  restart(): void {
    this.consecutiveFailures = 0;
    this.intentionalStop = false;
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch (err) {
        this.logger.warn({ err }, "kill(crg) during restart failed");
      }
    }
    this.transition({
      phase: "restarting",
      restartCount: this.state.restartCount + 1,
    });
    this.child = null;
    this.start();
  }

  private attachChild(child: CrgSpawnHandle): void {
    this.child = child;
    this.startRssMonitor(child);
    child.stdout?.on("data", (chunk: Buffer) => this.emit("stdout", chunk));
    // Surface stderr to the logger — crg prints diagnostics there. Without
    // this the subprocess is a black box when the MCP call hangs.
    child.stderr?.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk);
      const text = chunk.toString("utf8").trimEnd();
      if (text.length > 0) {
        this.logger.debug({ pid: child.pid }, `crg stderr: ${text}`);
      }
    });
    // Capture `child` in closure and compare against `this.child` before
    // handling — restarts spawn a new child before the old one's `exit`
    // event fires, and without this guard the stale event would nuke the
    // fresh subprocess's state and trigger another auto-restart → double
    // subprocesses after every Restart click.
    const isStale = () => this.child !== child;
    child.on("error", (err) => {
      if (isStale()) {
        this.logger.debug(
          { err, pid: child.pid },
          "ignoring error from stale (already-replaced) crg subprocess",
        );
        return;
      }
      this.logger.error({ err }, "crg subprocess emitted error");
      this.handleExit(null, null, err.message);
    });
    child.on("exit", (code, signal) => {
      if (isStale()) {
        this.logger.info(
          { code, signal, pid: child.pid },
          "stale crg subprocess exited (already replaced by restart)",
        );
        return;
      }
      this.logger.info({ code, signal, pid: child.pid }, "crg subprocess exited");
      this.handleExit(code, signal, null);
    });
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    errorMessage: string | null,
  ): void {
    this.stopRssMonitor();
    const wasRunning = this.state.phase === "running" || this.state.phase === "starting";
    this.child = null;
    if (this.intentionalStop) {
      this.transition({
        phase: "stopped",
        restartCount: this.state.restartCount,
        lastExit: { code, signal, at: Date.now() },
      });
      return;
    }
    if (!wasRunning) {
      // Ignore stale exit events
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.transition({
        phase: "failed",
        restartCount: this.state.restartCount,
        lastExit: { code, signal, at: Date.now() },
        lastError:
          errorMessage ??
          `Exited with code=${code} signal=${signal} (giving up after ${this.consecutiveFailures} failures)`,
      });
      return;
    }
    const delay = Math.min(
      this.initialBackoff * 2 ** (this.consecutiveFailures - 1),
      this.maxBackoff,
    );
    this.transition({
      phase: "restarting",
      restartCount: this.state.restartCount + 1,
      lastExit: { code, signal, at: Date.now() },
      lastError: errorMessage ?? `Exited with code=${code} signal=${signal}`,
    });
    this.pendingRestart = this.schedule(() => {
      this.pendingRestart = null;
      this.start();
    }, delay);
  }

  private cancelPendingRestart(): void {
    if (this.pendingRestart) {
      this.pendingRestart.cancel();
      this.pendingRestart = null;
    }
  }

  private transition(next: CrgProcessState): void {
    this.state = next;
    this.emit("state", { ...next });
  }

  private startRssMonitor(child: CrgSpawnHandle): void {
    this.stopRssMonitor();
    if (this.maxRssBytes <= 0) return;
    const pid = child.pid;
    this.rssMonitorTimer = setInterval(() => {
      // Only check the current child — restarts swap `this.child`, and we
      // don't want a stale timer killing the new process.
      if (this.child !== child) {
        this.stopRssMonitor();
        return;
      }
      void this.rssOf(pid)
        .then((rss) => {
          if (rss === null) return;
          if (rss <= this.maxRssBytes) return;
          this.logger.error(
            {
              pid,
              rssBytes: rss,
              rssMb: Math.round(rss / (1024 * 1024)),
              limitMb: Math.round(this.maxRssBytes / (1024 * 1024)),
            },
            "crg subprocess exceeded RSS limit — killing before kernel OOM",
          );
          this.stopRssMonitor();
          try {
            child.kill("SIGTERM");
          } catch (err) {
            this.logger.warn({ err }, "kill(crg, SIGTERM) on RSS-exceed failed");
          }
          // Escalate to SIGKILL if SIGTERM doesn't take. The exit handler
          // will treat this as a failure and trigger backoff/restart.
          setTimeout(() => {
            if (this.child === child) {
              try {
                child.kill("SIGKILL");
              } catch (err) {
                this.logger.warn({ err }, "kill(crg, SIGKILL) on RSS-exceed failed");
              }
            }
          }, RSS_KILL_GRACE_MS);
        })
        .catch((err) => {
          this.logger.debug({ err, pid }, "RSS poll failed (non-fatal)");
        });
    }, this.rssPollMs);
  }

  private stopRssMonitor(): void {
    if (this.rssMonitorTimer) {
      clearInterval(this.rssMonitorTimer);
      this.rssMonitorTimer = null;
    }
  }
}

async function defaultRssOf(pid: number): Promise<number | null> {
  return await new Promise((resolve) => {
    // `ps -o rss=` prints RSS in KB (BSD/Linux ps both support this). One
    // shell-out per poll interval (default 5s) is acceptable for a single
    // long-lived subprocess.
    const ps = nodeSpawn("ps", ["-o", "rss=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    ps.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    ps.on("error", () => resolve(null));
    ps.on("exit", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const kb = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(kb) || kb <= 0) {
        resolve(null);
        return;
      }
      resolve(kb * 1024);
    });
  });
}

function defaultSpawn(cmd: string, args: string[], env: NodeJS.ProcessEnv): CrgSpawnHandle {
  const child: ChildProcess = nodeSpawn(cmd, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (typeof child.pid !== "number") {
    throw new Error(`spawn(${cmd}) failed: pid is undefined`);
  }
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => child.kill(signal ?? undefined),
    on: (event: "exit" | "error", cb: (...args: any[]) => void) => child.on(event, cb),
  };
}

function defaultScheduleRestart(fn: () => void, delayMs: number): PendingRestart {
  const handle = setTimeout(fn, delayMs);
  return {
    cancel() {
      clearTimeout(handle);
    },
  };
}
