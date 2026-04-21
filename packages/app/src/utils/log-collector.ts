/**
 * LogCollector — captures all console output in a ring buffer so it can be
 * exported from inside the app for diagnostics.
 *
 * Call `installLogCollector()` once during app bootstrap, then use
 * `getCollectedLogs()` from Settings to retrieve the log text.
 */

const MAX_LINES = 5000; // Keep at most this many lines in memory

let buffer: string[] = [];
let installed = false;

function pushLine(line: string) {
  buffer.push(line);
  if (buffer.length > MAX_LINES) {
    buffer = buffer.slice(buffer.length - MAX_LINES);
  }
}

function formatArgs(method: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  const text = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  return `[${ts}] ${method} ${text}`;
}

/**
 * Install the log collector. This wraps console.log / warn / error / info
 * so that every call is buffered in addition to being printed as normal.
 * Safe to call multiple times — only the first call has any effect.
 */
export function installLogCollector() {
  if (installed) return;
  installed = true;

  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };

  console.log = (...args: unknown[]) => {
    pushLine(formatArgs("LOG", args));
    originals.log.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    pushLine(formatArgs("WARN", args));
    originals.warn.apply(console, args);
  };

  console.error = (...args: unknown[]) => {
    pushLine(formatArgs("ERROR", args));
    originals.error.apply(console, args);
  };

  console.info = (...args: unknown[]) => {
    pushLine(formatArgs("INFO", args));
    originals.info.apply(console, args);
  };

  pushLine(`[PD] LogCollector installed (buffer cap: ${MAX_LINES} lines)`);
}

/**
 * Return the full collected log buffer as a single string.
 */
export function getCollectedLogs(): string {
  return buffer.join("\n");
}

/**
 * Clear the buffer (e.g. after exporting).
 */
export function clearCollectedLogs() {
  buffer = [];
}
