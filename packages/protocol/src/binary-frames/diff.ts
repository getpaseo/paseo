import type { ParsedDiffFile } from "../messages.js";

// Opcodes 0x40–0x4f are reserved for diff revisions. Plugins own 0x20–0x2f.
export const DiffOpcode = { Begin: 0x40, Bodies: 0x41, End: 0x42 } as const;
export const DIFF_HIGHLIGHT_STYLES = [
  null,
  "keyword",
  "comment",
  "string",
  "number",
  "literal",
  "function",
  "definition",
  "class",
  "type",
  "tag",
  "attribute",
  "property",
  "variable",
  "operator",
  "punctuation",
  "regexp",
  "escape",
  "meta",
  "heading",
  "link",
] as const;
const CHANGES = ["added", "modified", "deleted", "renamed"] as const;
const CONTENTS = ["text", "binary"] as const;
const KINDS = ["context", "add", "remove", "header"] as const;
const ERRORS = [
  null,
  "NOT_GIT_REPO",
  "REF_NOT_FOUND",
  "INVALID_COMPARE",
  "TOO_MANY_SUBSCRIPTIONS",
  "UNKNOWN",
] as const;
export interface DiffEntry {
  path: string;
  oldPath: string | null;
  change: (typeof CHANGES)[number];
  content: (typeof CONTENTS)[number];
  additions: number;
  deletions: number;
  body: boolean;
}
export interface DiffRun {
  style: string | null;
  length: number;
}
export interface DiffStreamLine {
  type: (typeof KINDS)[number];
  content: string;
  runs?: DiffRun[];
}
export interface DiffStreamHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffStreamLine[];
}
export interface DiffBody {
  path: string;
  hunks: DiffStreamHunk[];
}
export interface DiffBegin {
  opcode: typeof DiffOpcode.Begin;
  slot: number;
  revision: number;
  baseRevision: number;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  entries: DiffEntry[];
}
export interface DiffBodies {
  opcode: typeof DiffOpcode.Bodies;
  slot: number;
  revision: number;
  files: DiffBody[];
}
export interface DiffEnd {
  opcode: typeof DiffOpcode.End;
  slot: number;
  revision: number;
  diffTooLarge: boolean;
  omitted: string[];
  error: { code: NonNullable<(typeof ERRORS)[number]>; message: string } | null;
}
export type DiffFrame = DiffBegin | DiffBodies | DiffEnd;
export class InvalidDiffFrameError extends Error {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Writer {
  private bytes: number[] = [];
  byte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new InvalidDiffFrameError("Invalid byte");
    this.bytes.push(value);
  }
  uint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new InvalidDiffFrameError("Invalid unsigned integer");
    do {
      const next = value % 128;
      value = Math.floor(value / 128);
      this.byte(next + (value ? 128 : 0));
    } while (value);
  }
  str(value: string): void {
    const bytes = textEncoder.encode(value);
    this.uint(bytes.length);
    for (const byte of bytes) this.byte(byte);
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
class Reader {
  private offset = 0;
  constructor(private bytes: Uint8Array) {}
  byte(): number {
    if (this.offset >= this.bytes.length) throw new InvalidDiffFrameError("Truncated diff frame");
    return this.bytes[this.offset++];
  }
  uint(): number {
    let value = 0;
    let factor = 1;
    for (let index = 0; index < 8; index++) {
      const byte = this.byte();
      value += (byte & 127) * factor;
      if (!Number.isSafeInteger(value)) throw new InvalidDiffFrameError("Integer overflow");
      if (byte < 128) return value;
      factor *= 128;
    }
    throw new InvalidDiffFrameError("Invalid varint");
  }
  count(): number {
    const value = this.uint();
    if (value > this.bytes.length - this.offset)
      throw new InvalidDiffFrameError("Count exceeds frame");
    return value;
  }
  str(): string {
    const size = this.count();
    const start = this.offset;
    this.offset += size;
    try {
      return textDecoder.decode(this.bytes.subarray(start, this.offset));
    } catch {
      throw new InvalidDiffFrameError("Invalid UTF-8");
    }
  }
  done(): void {
    if (this.offset !== this.bytes.length) throw new InvalidDiffFrameError("Trailing bytes");
  }
}
function enumAt<T>(values: readonly T[], index: number): T {
  if (index >= values.length) throw new InvalidDiffFrameError("Unknown enum value");
  return values[index];
}
function validateRuns(line: DiffStreamLine): void {
  if (!line.runs) return;
  let length = 0;
  for (const run of line.runs) {
    if (!Number.isSafeInteger(run.length) || run.length <= 0)
      throw new InvalidDiffFrameError("Invalid run length");
    length += run.length;
  }
  if (length !== line.content.length) throw new InvalidDiffFrameError("Runs do not cover line");
}
function writeLine(writer: Writer, line: DiffStreamLine): void {
  validateRuns(line);
  writer.byte(KINDS.indexOf(line.type) | (line.runs ? 128 : 0));
  writer.str(line.content);
  writer.uint(line.runs ? line.runs.length : 0);
  for (const run of line.runs ?? []) {
    const style = DIFF_HIGHLIGHT_STYLES.findIndex((value) => value === run.style);
    writer.byte(Math.max(0, style));
    writer.uint(run.length);
  }
}
function readLine(reader: Reader): DiffStreamLine {
  const flags = reader.byte();
  const type = enumAt(KINDS, flags & 127);
  const content = reader.str();
  const count = reader.count();
  const runs: DiffRun[] = [];
  for (let index = 0; index < count; index++) {
    const styleIndex = reader.byte();
    const style = DIFF_HIGHLIGHT_STYLES[styleIndex] ?? null;
    runs.push({ style, length: reader.uint() });
  }
  if (!(flags & 128)) {
    if (count) throw new InvalidDiffFrameError("Runs without flag");
    return { type, content };
  }
  const line = { type, content, runs };
  validateRuns(line);
  return line;
}
export function encodeDiffFrame(frame: DiffFrame): Uint8Array {
  const writer = new Writer();
  writer.byte(frame.opcode);
  writer.byte(frame.slot);
  writer.byte(1);
  writer.uint(frame.revision);
  if (frame.opcode === DiffOpcode.Begin) {
    writer.uint(frame.baseRevision);
    writer.str(frame.baseSha);
    writer.str(frame.headSha);
    writer.str(frame.mergeBaseSha);
    writer.uint(frame.entries.length);
    for (const entry of frame.entries) {
      if (entry.content === "binary" && entry.body)
        throw new InvalidDiffFrameError("Binary entry has a body");
      writer.str(entry.path);
      writer.str(entry.oldPath ?? "");
      writer.byte(CHANGES.indexOf(entry.change));
      writer.byte(CONTENTS.indexOf(entry.content));
      writer.uint(entry.additions);
      writer.uint(entry.deletions);
      writer.byte(Number(entry.body));
    }
  } else if (frame.opcode === DiffOpcode.Bodies) {
    writer.uint(frame.files.length);
    for (const file of frame.files) {
      writer.str(file.path);
      writer.uint(file.hunks.length);
      for (const hunk of file.hunks) {
        writer.uint(hunk.oldStart);
        writer.uint(hunk.oldCount);
        writer.uint(hunk.newStart);
        writer.uint(hunk.newCount);
        writer.uint(hunk.lines.length);
        for (const line of hunk.lines) writeLine(writer, line);
      }
    }
  } else {
    writer.byte(Number(frame.diffTooLarge));
    writer.uint(frame.omitted.length);
    for (const path of frame.omitted) writer.str(path);
    writer.byte(frame.error ? ERRORS.indexOf(frame.error.code) : 0);
    writer.str(frame.error ? frame.error.message : "");
  }
  return writer.finish();
}
export function decodeDiffFrame(bytes: Uint8Array): DiffFrame {
  const reader = new Reader(bytes);
  const opcode = reader.byte();
  const slot = reader.byte();
  if (reader.byte() !== 1) throw new InvalidDiffFrameError("Unknown diff version");
  const revision = reader.uint();
  let frame: DiffFrame;
  if (opcode === DiffOpcode.Begin) {
    const baseRevision = reader.uint();
    const baseSha = reader.str();
    const headSha = reader.str();
    const mergeBaseSha = reader.str();
    const count = reader.count();
    const entries: DiffEntry[] = [];
    for (let index = 0; index < count; index++) {
      const path = reader.str();
      const oldPath = reader.str() || null;
      const change = enumAt(CHANGES, reader.byte());
      const content = enumAt(CONTENTS, reader.byte());
      const additions = reader.uint();
      const deletions = reader.uint();
      const bodyByte = reader.byte();
      if (bodyByte > 1 || (content === "binary" && bodyByte))
        throw new InvalidDiffFrameError("Invalid entry body");
      entries.push({ path, oldPath, change, content, additions, deletions, body: bodyByte === 1 });
    }
    frame = { opcode, slot, revision, baseRevision, baseSha, headSha, mergeBaseSha, entries };
  } else if (opcode === DiffOpcode.Bodies) {
    const count = reader.count();
    const files: DiffBody[] = [];
    for (let index = 0; index < count; index++) {
      const path = reader.str();
      const hunkCount = reader.count();
      const hunks: DiffStreamHunk[] = [];
      for (let h = 0; h < hunkCount; h++) {
        const oldStart = reader.uint();
        const oldCount = reader.uint();
        const newStart = reader.uint();
        const newCount = reader.uint();
        const lineCount = reader.count();
        const lines: DiffStreamLine[] = [];
        for (let l = 0; l < lineCount; l++) lines.push(readLine(reader));
        hunks.push({ oldStart, oldCount, newStart, newCount, lines });
      }
      files.push({ path, hunks });
    }
    frame = { opcode, slot, revision, files };
  } else if (opcode === DiffOpcode.End) {
    const flags = reader.byte();
    if (flags > 1) throw new InvalidDiffFrameError("Unknown flags");
    const count = reader.count();
    const omitted: string[] = [];
    for (let index = 0; index < count; index++) omitted.push(reader.str());
    const code = enumAt(ERRORS, reader.byte());
    const message = reader.str();
    frame = {
      opcode,
      slot,
      revision,
      diffTooLarge: flags === 1,
      omitted,
      error: code ? { code, message } : null,
    };
  } else {
    throw new InvalidDiffFrameError("Unknown diff opcode");
  }
  reader.done();
  return frame;
}
export function runsToTokens(
  line: DiffStreamLine,
): NonNullable<ParsedDiffFile["hunks"][number]["lines"][number]["tokens"]> {
  let offset = 0;
  return (line.runs ?? []).map((run) => {
    const text = line.content.slice(offset, offset + run.length);
    offset += run.length;
    return { text, style: run.style };
  });
}
export function materializeDiffFile(
  entry: DiffEntry,
  body: DiffBody | null,
  omitted: boolean,
): ParsedDiffFile {
  let status: "ok" | "binary" | "too_large" = "ok";
  if (entry.content === "binary") status = "binary";
  else if (omitted) status = "too_large";
  const hunks = body
    ? body.hunks.map((hunk) => ({
        ...hunk,
        lines: hunk.lines.map((line) => {
          if (line.runs)
            return { type: line.type, content: line.content, tokens: runsToTokens(line) };
          return { type: line.type, content: line.content };
        }),
      }))
    : [];
  const file: ParsedDiffFile = {
    path: entry.path,
    isNew: entry.change === "added",
    isDeleted: entry.change === "deleted",
    additions: entry.additions,
    deletions: entry.deletions,
    hunks,
    status,
  };
  if (entry.oldPath !== null) file.oldPath = entry.oldPath;
  return file;
}
