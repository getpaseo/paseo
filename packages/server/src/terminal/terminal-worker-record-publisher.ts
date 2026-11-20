import type { TerminalWorkerRecord } from "./terminal-worker-record.js";

const TRANSIENT_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Serializes live worker publication, retaining the latest state across reader contention.
 * Creation awaits publication; exit notifications need not wait for a reader to close.
 * Stop before retiring the record so a pending retry cannot recreate it.
 */
export function createTerminalWorkerRecordPublisher(write: (record: TerminalWorkerRecord) => void) {
  let stopped = false;
  let latest: TerminalWorkerRecord;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending:
    | {
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  function attempt(): void {
    timer = undefined;
    const publication = pending;
    if (!publication) return;
    try {
      write(latest);
      publication.resolve();
      pending = undefined;
    } catch (error) {
      if (TRANSIENT_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) {
        timer = setTimeout(attempt, 25);
      } else {
        publication.reject(error);
        pending = undefined;
      }
    }
  }

  return {
    publish(record: TerminalWorkerRecord): Promise<void> {
      if (stopped) return Promise.reject(new Error("Worker record publisher stopped"));
      latest = record;
      if (pending) return pending.promise;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending = { promise, resolve, reject };
      attempt();
      return promise;
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      pending?.reject(new Error("Worker record publisher stopped"));
      pending = undefined;
    },
  };
}
