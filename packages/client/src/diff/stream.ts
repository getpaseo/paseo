import {
  DiffOpcode,
  materializeDiffFile,
  type DiffBegin,
  type DiffBody,
  type DiffFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import type { DiffState } from "./index.js";

/** Owns revision assembly. End, rather than a local body count, commits the snapshot. */
export class DiffStream {
  private pending: { begin: DiffBegin; bodies: Map<string, DiffBody> } | null = null;
  private committed: Extract<DiffState, { phase: "ready" }> | null = null;
  constructor(private publish: (state: DiffState) => void) {}
  receive(frame: DiffFrame): void {
    if (frame.opcode === DiffOpcode.Begin) {
      if (frame.baseRevision !== 0 && frame.baseRevision !== this.committed?.revision)
        throw new Error("Unknown diff base revision");
      if (new Set(frame.entries.map((entry) => entry.path)).size !== frame.entries.length)
        throw new Error("Duplicate diff entry");
      this.pending = { begin: frame, bodies: new Map() };
      if (!this.committed)
        this.publish({
          phase: "loading",
          revision: frame.revision,
          entries: frame.entries.map(({ body: _body, ...entry }) => entry),
        });
      return;
    }
    const pending = this.pending;
    if (!pending || frame.revision !== pending.begin.revision) return;
    if (frame.opcode === DiffOpcode.Bodies) {
      for (const body of frame.files) {
        if (pending.bodies.has(body.path)) throw new Error("Duplicate diff body");
        const entry = pending.begin.entries.find((candidate) => candidate.path === body.path);
        if (!entry?.body) throw new Error("Unexpected diff body");
        pending.bodies.set(body.path, body);
      }
      return;
    }
    this.pending = null;
    if (frame.error) {
      this.committed = null;
      this.publish({ phase: "error", revision: frame.revision, error: frame.error });
      return;
    }
    const previous = new Map(this.committed?.files.map((file) => [file.path, file]));
    const omitted = new Set(frame.omitted);
    for (const path of omitted)
      if (!pending.begin.entries.some((entry) => entry.path === path))
        throw new Error("Unknown omitted diff path");
    const files = pending.begin.entries.map((entry) => {
      const old = previous.get(entry.path);
      const body = pending.bodies.get(entry.path);
      if (entry.content === "text" && !omitted.has(entry.path) && entry.body && !body)
        throw new Error(`Missing diff body: ${entry.path}`);
      if (
        entry.content === "text" &&
        !entry.body &&
        !omitted.has(entry.path) &&
        (!old || pending.begin.baseRevision === 0)
      )
        throw new Error(`Missing inherited diff: ${entry.path}`);
      let file = materializeDiffFile(entry, body ?? null, omitted.has(entry.path));
      if (entry.content === "text" && !entry.body && !omitted.has(entry.path) && old)
        file = { ...file, hunks: old.hunks, status: old.status };
      return old && sameFile(old, file) ? old : file;
    });
    const { revision, baseSha, headSha, mergeBaseSha } = pending.begin;
    this.committed = {
      phase: "ready",
      revision,
      resolved: { baseSha, headSha, mergeBaseSha },
      files,
      diffTooLarge: frame.diffTooLarge,
    };
    this.publish(this.committed);
  }
}
function sameFile(a: ParsedDiffFile, b: ParsedDiffFile): boolean {
  if (
    a.path !== b.path ||
    a.oldPath !== b.oldPath ||
    a.isNew !== b.isNew ||
    a.isDeleted !== b.isDeleted ||
    a.additions !== b.additions ||
    a.deletions !== b.deletions ||
    a.status !== b.status
  )
    return false;
  if (a.hunks === b.hunks) return true;
  return JSON.stringify(a.hunks) === JSON.stringify(b.hunks);
}
