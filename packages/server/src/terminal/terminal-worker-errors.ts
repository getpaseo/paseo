/**
 * The daemon's socket to the terminal worker closed while a request was pending. The worker
 * itself survives (it keeps its terminals) and the manager reconnects, so a caller that only
 * needs worker state can wait for the reconnect and ask again instead of treating this as a
 * terminal exit.
 */
export class TerminalWorkerConnectionClosedError extends Error {
  readonly code = "terminal_worker_connection_closed";

  constructor(message = "Terminal worker connection closed") {
    super(message);
    this.name = "TerminalWorkerConnectionClosedError";
  }
}
