import { Worker } from "node:worker_threads";
import type { Logger } from "pino";

const CHECKPOINT_INTERVAL_MS = 1000;
const STOP_TIMEOUT_MS = 2000;

const RUNNING = 0;
const STOPPING = 1;
const STOPPED = 1;

/**
 * Runs in the worker. It sleeps on the shared state, so `stop` wakes it at once, and needs no
 * event loop: a checkpoint is one synchronous call.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.state);
let connection;
try {
  connection = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(workerData.path);
  while (Atomics.wait(state, 0, ${RUNNING}, workerData.intervalMs) === "timed-out") {
    try {
      connection.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    } catch (error) {
      parentPort.postMessage(String(error && error.message ? error.message : error));
    }
  }
} catch (error) {
  parentPort.postMessage(String(error && error.message ? error.message : error));
} finally {
  try { connection && connection.close(); } catch {}
  Atomics.store(state, 1, ${STOPPED});
  Atomics.notify(state, 1);
}
`;

/**
 * Copies committed WAL pages into the database file from a worker thread. A checkpoint syncs the
 * file to disk, which takes up to a hundred milliseconds; on the daemon thread it would stall the
 * event loop on whichever write crossed SQLite's auto-checkpoint threshold. A passive checkpoint
 * takes no lock a writer needs, so it runs alongside the daemon's writes.
 */
export class WalCheckpointer {
  private readonly state = new Int32Array(new SharedArrayBuffer(8));
  private readonly worker: Worker;
  private stopped = false;

  /** `onExit` runs when the worker ends before `stop`, so checkpoints have stopped. */
  constructor(input: { path: string; logger: Logger; onExit: () => void }) {
    const { logger } = input;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        path: input.path,
        state: this.state.buffer,
        intervalMs: CHECKPOINT_INTERVAL_MS,
      },
      // Node 22 prints an experimental warning when the worker loads node:sqlite; the daemon
      // already printed it once.
      stderr: true,
    });
    this.worker.stderr.resume();
    this.worker.on("message", (message: string) => {
      logger.warn({ error: message }, "Database WAL checkpoint failed");
    });
    this.worker.on("error", (error) => {
      logger.warn({ err: error }, "Database WAL checkpointer failed");
    });
    this.worker.on("exit", () => {
      if (!this.stopped) input.onExit();
    });
    this.worker.unref();
  }

  /**
   * Stops the worker, blocking until it has closed its connection, for at most two seconds. False
   * when it had not closed by then; it is terminated either way.
   */
  stop(): boolean {
    if (this.stopped) return true;
    this.stopped = true;
    Atomics.store(this.state, 0, STOPPING);
    Atomics.notify(this.state, 0);
    const closed = Atomics.wait(this.state, 1, 0, STOP_TIMEOUT_MS) !== "timed-out";
    void this.worker.terminate();
    return closed;
  }
}
