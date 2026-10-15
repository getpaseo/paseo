// Pure OSC 7501 (Program Status Protocol) parsing and record storage.
// No xterm imports: this module never touches the terminal emulator.

// States a record can hold; `clear` is a report action, never a stored state.
export type ProgramStatusState = "idle" | "working" | "done" | "blocked" | "error";

export type ProgramStatusBlockedKind = "permission" | "question" | "auth";

export interface ProgramStatusReport {
  state: ProgramStatusState | "clear";
  // Null addresses the root record.
  id: string | null;
  kind?: ProgramStatusBlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

// Sets, not object literals: a lookup on an object also finds inherited names
// such as `constructor`.
const KNOWN_STATES: ReadonlySet<string> = new Set([
  "idle",
  "working",
  "done",
  "blocked",
  "error",
  "clear",
]);

const KNOWN_KINDS: ReadonlySet<string> = new Set(["permission", "question", "auth"]);

// Fixed OSC framing overhead: `ESC ] 7501 ;` (7 bytes) plus ST (up to 2 bytes).
const SEQUENCE_OVERHEAD_BYTES = 9;
const MAX_SEQUENCE_BYTES = 4096;
const MAX_KEY_BYTES = 16;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;
const MAX_TITLE_ENCODED_BYTES = 256;
const MAX_TITLE_DECODED_BYTES = 192;
const MAX_MSG_ENCODED_BYTES = 2732;
const MAX_MSG_DECODED_BYTES = 2048;
const MAX_RECORDS_PER_TERMINAL = 256;

const KEY_PATTERN = /^[a-z]+$/;
const VALUE_PATTERN = /^[A-Za-z0-9_.,+/=-]*$/;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const PROGRESS_PATTERN = /^\d+$/;
// Standard base64 with optional padding: padding only at the very end.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// Rejects U+0000-U+001F, U+007F, and U+0080-U+009F via code points
// (written hex so the source itself never holds literal controls).
function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

// Strict standard-base64 decode of UTF-8 text. Returns null when the value
// does not decode (bad alphabet, misplaced padding, undecodable length, or
// invalid UTF-8). Padding is optional, so unpadded lengths with remainder
// 2 or 3 are accepted; remainder 1 never decodes.
function decodeBase64Text(encoded: string): string | null {
  if (encoded.length === 0) {
    return "";
  }
  if (encoded.includes("=") && encoded.length % 4 !== 0) {
    return null;
  }
  if (!BASE64_PATTERN.test(encoded)) {
    return null;
  }
  if (!encoded.includes("=") && encoded.length % 4 === 1) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

function decodeFreeText(
  encoded: string,
  maxEncodedBytes: number,
  maxDecodedBytes: number,
): string | null {
  // Check the encoded size before decoding.
  if (Buffer.byteLength(encoded, "utf8") > maxEncodedBytes) {
    return null;
  }
  const text = decodeBase64Text(encoded);
  if (text === null) {
    return null;
  }
  if (Buffer.byteLength(text, "utf8") > maxDecodedBytes) {
    return null;
  }
  if (hasControlChars(text)) {
    return null;
  }
  return text;
}

function parseId(raw: string): string | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_ID_BYTES) {
    return null;
  }
  const segments = raw.split("/");
  if (segments.length === 0 || segments.length > MAX_ID_DEPTH) {
    return null;
  }
  for (const segment of segments) {
    if (!ID_SEGMENT_PATTERN.test(segment)) {
      return null;
    }
  }
  return raw;
}

// Splits `key=value(:key=value)*`, skipping malformed pairs; the last value
// wins for repeated keys. Returns null when a key breaks its size limit.
function parsePairs(body: string): Map<string, string> | null {
  const pairs = new Map<string, string>();
  for (const rawPair of body.trim().split(":")) {
    const separator = rawPair.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = rawPair.slice(0, separator).trim();
    const value = rawPair.slice(separator + 1).trim();
    if (key.length === 0 || !KEY_PATTERN.test(key)) {
      continue;
    }
    if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
      return null;
    }
    if (!VALUE_PATTERN.test(value)) {
      continue;
    }
    pairs.set(key, value);
  }
  return pairs;
}

// progress only rides along with working/blocked; anything else is absent.
function parseProgress(
  state: ProgramStatusReport["state"],
  raw: string | undefined,
): number | undefined {
  if (
    (state !== "working" && state !== "blocked") ||
    raw === undefined ||
    !PROGRESS_PATTERN.test(raw)
  ) {
    return undefined;
  }
  const progress = Number(raw);
  return progress <= 100 ? progress : undefined;
}

// Parses the body of an `OSC 7501 ; <body> ST` sequence (everything between
// `7501;` and ST). Returns a validated report, or null when the report must
// be ignored or discarded whole.
export function parseProgramStatusReport(body: string): ProgramStatusReport | null {
  if (Buffer.byteLength(body, "utf8") + SEQUENCE_OVERHEAD_BYTES > MAX_SEQUENCE_BYTES) {
    return null;
  }
  const pairs = parsePairs(body);
  const state = pairs?.get("state");
  if (!pairs || state === undefined || !KNOWN_STATES.has(state)) {
    return null;
  }

  const rawId = pairs.get("id");
  const id = rawId === undefined ? null : parseId(rawId);
  if (rawId !== undefined && id === null) {
    // Never fall back to the root record for a malformed id.
    return null;
  }

  const report: ProgramStatusReport = {
    state: state as ProgramStatusReport["state"],
    id,
  };

  // kind only rides along with blocked; unrecognized values are absent.
  const rawKind = pairs.get("kind");
  if (report.state === "blocked" && rawKind !== undefined && KNOWN_KINDS.has(rawKind)) {
    report.kind = rawKind as ProgramStatusBlockedKind;
  }

  const progress = parseProgress(report.state, pairs.get("progress"));
  if (progress !== undefined) {
    report.progress = progress;
  }

  const rawApp = pairs.get("app");
  if (rawApp !== undefined && APP_PATTERN.test(rawApp)) {
    report.app = rawApp;
  }

  const rawTitle = pairs.get("title");
  if (rawTitle !== undefined) {
    const title = decodeFreeText(rawTitle, MAX_TITLE_ENCODED_BYTES, MAX_TITLE_DECODED_BYTES);
    if (title === null) {
      return null;
    }
    report.title = title;
  }

  const rawMsg = pairs.get("msg");
  if (rawMsg !== undefined) {
    const msg = decodeFreeText(rawMsg, MAX_MSG_ENCODED_BYTES, MAX_MSG_DECODED_BYTES);
    if (msg === null) {
      return null;
    }
    report.msg = msg;
  }

  return report;
}

interface StoredRecord {
  report: ProgramStatusReport;
  // Monotonic update counter backing least-recently-updated eviction.
  updatedSeq: number;
}

// Per-terminal set of program status records, one per id.
export class ProgramStatusRecords {
  private readonly records = new Map<string, StoredRecord>();
  private updateSeq = 0;

  get size(): number {
    return this.records.size;
  }

  // A record without `app` takes it from its nearest ancestor that has one;
  // the root record is every id's last ancestor.
  get(id: string | null): ProgramStatusReport | undefined {
    const report = this.records.get(id ?? "")?.report;
    if (!report || report.app !== undefined || id === null) {
      return report;
    }
    let ancestor = id;
    while (ancestor !== "") {
      const slash = ancestor.lastIndexOf("/");
      ancestor = slash === -1 ? "" : ancestor.slice(0, slash);
      const app = this.records.get(ancestor)?.report.app;
      if (app !== undefined) {
        return { ...report, app };
      }
    }
    return report;
  }

  // Each report REPLACES its record completely. `clear` removes the
  // addressed record and every descendant (`x` and `x/...`); `clear` with
  // no id removes every record.
  apply(report: ProgramStatusReport): void {
    const key = report.id ?? "";
    if (report.state === "clear") {
      if (report.id === null) {
        this.records.clear();
        return;
      }
      for (const existing of Array.from(this.records.keys())) {
        if (existing === key || existing.startsWith(`${key}/`)) {
          this.records.delete(existing);
        }
      }
      return;
    }
    if (!this.records.has(key) && this.records.size >= MAX_RECORDS_PER_TERMINAL) {
      let oldestKey: string | undefined;
      let oldestSeq = Number.POSITIVE_INFINITY;
      for (const [existing, stored] of this.records) {
        if (stored.updatedSeq < oldestSeq) {
          oldestSeq = stored.updatedSeq;
          oldestKey = existing;
        }
      }
      if (oldestKey !== undefined) {
        this.records.delete(oldestKey);
      }
    }
    this.updateSeq += 1;
    this.records.set(key, { report: { ...report }, updatedSeq: this.updateSeq });
  }

  // Drops working and blocked records (process exit / new shell prompt).
  // Keeps idle, done, and error. Returns whether anything was dropped.
  dropLiveRecords(): boolean {
    let dropped = false;
    for (const [key, stored] of Array.from(this.records)) {
      if (stored.report.state === "working" || stored.report.state === "blocked") {
        this.records.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  // Aggregate state across records: blocked > working > error > done > idle.
  resolve(): ProgramStatusState | null {
    let resolved: ProgramStatusState | null = null;
    let resolvedRank = -1;
    for (const stored of this.records.values()) {
      let rank: number;
      switch (stored.report.state) {
        case "blocked":
          rank = 4;
          break;
        case "working":
          rank = 3;
          break;
        case "error":
          rank = 2;
          break;
        case "done":
          rank = 1;
          break;
        case "idle":
          rank = 0;
          break;
        default:
          continue;
      }
      if (rank > resolvedRank) {
        resolvedRank = rank;
        resolved = stored.report.state;
      }
    }
    return resolved;
  }
}
