/**
 * How the daemon words a failed run or a failed goal. The daemon writes these into the log;
 * the diagnosis and the Manager read them back, so both sides import them from here.
 */

/** Start of the error a run that hit its turn time limit fails with. */
export const TURN_TIMEOUT_PREFIX = "Turn timed out after";

/** Start of the error a run the Lead stopped from a check-in fails with. */
export const LEAD_STOP_PREFIX = "Stopped by the Lead:";

/** The error of a run whose agent was canceled. */
export const RUN_CANCELED_TEXT = "Agent run was canceled";

/** How each pending-request failure starts. */
export const PENDING_QUESTION_PREFIX = "Agent asked a question";
export const PENDING_PERMISSION_PREFIX = "Agent is waiting for permission";
/** The wording before requests were described; older logs carry it. */
export const LEGACY_PERMISSION_FAILURE =
  "Agent is waiting for a permission approval; unattended runs cannot continue";

/** True for a run that stopped because its agent asked something nobody could answer. */
export function isPendingRequestFailure(error: string | null | undefined): boolean {
  return (
    !!error &&
    (error.startsWith(PENDING_QUESTION_PREFIX) ||
      error.startsWith(PENDING_PERMISSION_PREFIX) ||
      error.startsWith(LEGACY_PERMISSION_FAILURE))
  );
}

/**
 * Start of the error a run fails with when a person did not answer one of its agent's requests
 * within `limits.userWaitMinutes`: `No answer within <n> minutes: <the request>`.
 */
export const NO_ANSWER_PREFIX = "No answer within";

/** True for a run that failed because nobody answered its agent's request in time. */
export function isNoAnswerFailure(error: string | null | undefined): boolean {
  return !!error && error.startsWith(NO_ANSWER_PREFIX);
}

/**
 * True for a text that quotes a no-answer error anywhere, as a reviewer's, verifier's or
 * planning Lead's failure does: `Review failed: Reviewer did not finish (failed: No answer …)`.
 */
export function mentionsNoAnswer(text: string | null | undefined): boolean {
  return !!text && text.includes(`${NO_ANSWER_PREFIX} `);
}

/** Goal failure reasons the deadline timer writes: `Time limit of <n> minutes reached`. */
export const TIME_LIMIT_REACHED_PREFIX = "Time limit of";
/** `Deadline <deadlineAt> reached`. */
export const DEADLINE_REACHED_PATTERN = /^Deadline .* reached/;

/** Goal failure reasons for work that could not be captured for review. */
export const CAPTURE_FAILED_PREFIX = "Could not capture changes";
export const WORK_NOT_RECOVERED_PREFIX = "Could not recover the work of task";

/**
 * Goal failure reason when the verifier judged criteria and found some unmet:
 * `Acceptance criteria not met: <criterion> (<evidence>); ...`. Any other reason of a goal whose
 * tasks all succeeded (`Verification failed: ...`, a time limit or deadline) means the
 * unverified criteria were never judged.
 */
export const VERIFICATION_NOT_MET_PREFIX = "Acceptance criteria not met:";

export function isCriteriaNotMetFailure(reason: string | null | undefined): boolean {
  return !!reason && reason.startsWith(VERIFICATION_NOT_MET_PREFIX);
}

/** Goal failure reason when the daemon could not resume the goal after a restart. */
export const RESUME_FAILED_PREFIX = "Recovery failed";

/**
 * Start of the error a run fails with when its worker ended with `TASK_STATUS: blocked: <reason>`.
 * The reason is the worker's own claim; nothing checks it.
 */
export const WORKER_BLOCKED_PREFIX = "Worker reported it was blocked:";

/** Longest reason a blocked status line keeps; longer is cut. */
export const MAX_WORKER_BLOCKED_REASON_CHARS = 300;

export type WorkerStatus = { status: "done" } | { status: "blocked"; reason: string };

/** Lines from the end of a final message where a status line is looked for. */
const STATUS_SCAN_LINES = 5;
/** A longer line is never a status line; it is not normalized, which keeps the scan linear. */
const MAX_STATUS_LINE_CHARS = 1000;
const STATUS_LINE =
  /^task_status\s*[:：]\s*(?:(done)\.?|blocked\.?(?:(?:\s*[:：—–-]\s*|\s+)(.*))?)$/i;
const FENCE_LINE = /^(`{3,}|~{3,})\S*$/;

function isFence(line: string | undefined): boolean {
  return line !== undefined && FENCE_LINE.test(line.trim());
}

function normalizeStatusLine(line: string): string {
  // Quote, heading and list markers, as in `> TASK_STATUS: done` or `- TASK_STATUS: done`.
  let text = line
    .trim()
    .replace(/^(?:>\s*)+/, "")
    .replace(/^(?:#+|-)\s+/, "");
  // Markdown wrappers around the whole line, as in **TASK_STATUS: done** or `TASK_STATUS: done`.
  text = text
    .replace(/^[*_`]+/, "")
    .replace(/[*_`]+$/, "")
    .trim();
  return text.replace(/\s+/g, " ");
}

interface FoundStatus {
  status: WorkerStatus;
  /** The lines that hold the status line: the line itself, or with the fences around it. */
  first: number;
  last: number;
}

/** The index of the nearest non-blank line from `from` in direction `step`, or -1. */
function nonBlank(lines: readonly string[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < lines.length; i += step) {
    if ((lines[i] ?? "").trim() !== "") return i;
  }
  return -1;
}

/**
 * Where a status line at `index` sits. Outside any fence it counts. Inside a fence it counts
 * only when the fence holds that line alone and nothing follows the fence; a status line in a
 * longer fenced example is an example. Null when it does not count.
 */
function statusLines(
  lines: readonly string[],
  index: number,
): { first: number; last: number } | null {
  let fencesBefore = 0;
  for (let i = 0; i < index; i++) if (isFence(lines[i])) fencesBefore++;
  if (fencesBefore % 2 === 0) return { first: index, last: index };
  const open = nonBlank(lines, index - 1, -1);
  const close = nonBlank(lines, index + 1, 1);
  if (open < 0 || close < 0 || !isFence(lines[open]) || !isFence(lines[close])) return null;
  if (nonBlank(lines, close + 1, 1) >= 0) return null;
  return { first: open, last: close };
}

/** The status line of a final message, or null when there is none. */
function findWorkerStatus(lines: readonly string[]): FoundStatus | null {
  let scanned = 0;
  for (let i = lines.length - 1; i >= 0 && scanned < STATUS_SCAN_LINES; i--) {
    const line = lines[i] ?? "";
    // Blank lines and code fences are not counted.
    if (line.trim() === "" || isFence(line)) continue;
    scanned++;
    if (line.length > MAX_STATUS_LINE_CHARS) continue;
    const match = STATUS_LINE.exec(normalizeStatusLine(line));
    if (!match) continue;
    const at = statusLines(lines, i);
    if (!at) continue;
    if (match[1]) return { status: { status: "done" }, ...at };
    const reason = (match[2] ?? "").trim();
    // The prompt's own template copied back (`blocked: <one line: …>`) is no status at all.
    if (reason.startsWith("<") && reason.endsWith(">")) return null;
    return {
      status: {
        status: "blocked",
        reason: reason ? capReason(reason, MAX_WORKER_BLOCKED_REASON_CHARS) : "no reason given",
      },
      ...at,
    };
  }
  return null;
}

function capReason(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The worker's status line: the last `TASK_STATUS: done` or `TASK_STATUS: blocked: <reason>`
 * among the last 5 non-empty lines of its final message, outside a fenced example. Markdown
 * markers, case and extra spaces are ignored. Null when there is none; the run is then judged
 * as before the convention.
 */
export function workerStatus(text: string): WorkerStatus | null {
  return findWorkerStatus(text.split(/\r?\n/))?.status ?? null;
}

/** What a report says when the worker wrote nothing but its status line. */
export const EMPTY_REPORT_TEXT = "(no report)";

/** The final message without its status line (and a fence around it alone), for the task's report. */
export function withoutWorkerStatus(text: string): string {
  const lines = text.split(/\r?\n/);
  const found = findWorkerStatus(lines);
  if (!found) return text;
  lines.splice(found.first, found.last - found.first + 1);
  const report = lines.join("\n").trimEnd();
  return report.trim() === "" ? EMPTY_REPORT_TEXT : report;
}

/** True for a run that failed because its worker reported it was blocked. */
export function isWorkerBlocked(error: string | null | undefined): boolean {
  return !!error && error.startsWith(WORKER_BLOCKED_PREFIX);
}

/** The reason a blocked worker gave, or null for any other error. */
export function workerBlockedReason(error: string | null | undefined): string | null {
  return isWorkerBlocked(error) ? (error ?? "").slice(WORKER_BLOCKED_PREFIX.length).trim() : null;
}

/**
 * True for a run whose retry would stop the same way: only a person can change that. The one
 * place a new kind of such failure is added.
 */
export function needsPerson(error: string | null | undefined): boolean {
  return isPendingRequestFailure(error) || isWorkerBlocked(error) || isNoAnswerFailure(error);
}

/**
 * Whether a failed run waits for a person instead of an automatic retry. `waitsForPerson` is
 * the pending-request check the Manager makes against the permission policy the run started
 * under (a changed policy gets its retry); every other `needsPerson` failure always waits.
 */
export function personDecides(error: string | null | undefined, waitsForPerson: boolean): boolean {
  return waitsForPerson || (needsPerson(error) && !isPendingRequestFailure(error));
}

/**
 * The opening of a goal failure caused by a worker's blocked claim, quoted so the person sees
 * it was the worker's own claim.
 */
export function workerBlockedFailureText(taskId: string, error: string): string {
  return `Task ${taskId} stopped: the worker reported it was blocked: "${workerBlockedReason(error) ?? ""}". Fix what it names and retry.`;
}
