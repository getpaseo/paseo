import type { ParsedDiffFile } from "@getpaseo/protocol/messages";

export interface DiffMatch {
  file: ParsedDiffFile;
  hunkIndex: number;
  lineIndex: number;
  start: number;
  end: number;
}

export interface FindScheduler {
  schedule(run: () => void, delay: number): () => void;
  now(): number;
}

export type LineMatches = ReadonlyMap<ParsedDiffFile, ReadonlyMap<string, readonly DiffMatch[]>>;

export interface DiffFindSnapshot {
  phase: "closed" | "searching" | "ready";
  query: string;
  files: readonly ParsedDiffFile[];
  matches: readonly DiffMatch[];
  byLine: LineMatches;
  current: number;
  limited: boolean;
  skippedFiles: number;
}

const MATCH_LIMIT = 10_000;
const CHUNK_SIZE = 32_768;
const scheduler: FindScheduler = {
  schedule(run, delay) {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
  now: () => performance.now(),
};

function emptyResults(): Pick<
  DiffFindSnapshot,
  "matches" | "byLine" | "current" | "limited" | "skippedFiles"
> {
  return { matches: [], byLine: new Map(), current: -1, limited: false, skippedFiles: 0 };
}

/** Snapshot-local results never borrow mouse selection or renderer coordinates. */
export class DiffFindModel {
  private snapshot: DiffFindSnapshot = { phase: "closed", query: "", files: [], ...emptyResults() };
  private listeners = new Set<() => void>();
  private cancel: (() => void) | null = null;
  private generation = 0;
  // One query per open Find. Weak keys release files removed by a live diff update.
  private cache = new WeakMap<ParsedDiffFile, readonly DiffMatch[]>();

  constructor(private readonly clock: FindScheduler = scheduler) {}

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly setFiles = (files: readonly ParsedDiffFile[]) => {
    if (files === this.snapshot.files) return;
    this.snapshot = { ...this.snapshot, files };
    if (this.snapshot.phase !== "closed") this.search(0);
  };

  readonly open = () => {
    if (this.snapshot.phase !== "closed") return;
    this.snapshot = { ...this.snapshot, phase: "ready" };
    this.search(0);
  };

  readonly close = () => {
    this.stop();
    this.cache = new WeakMap();
    this.snapshot = { ...this.snapshot, phase: "closed", ...emptyResults() };
    this.publish();
  };

  readonly setQuery = (query: string) => {
    if (query === this.snapshot.query) return;
    this.cache = new WeakMap();
    this.snapshot = { ...this.snapshot, query };
    this.search(100);
  };

  readonly next = () => this.navigate(1);
  readonly previous = () => this.navigate(-1);

  readonly dispose = () => {
    this.stop();
    this.cache = new WeakMap();
  };

  private navigate(direction: number) {
    const { matches, current, phase } = this.snapshot;
    if (phase !== "ready" || matches.length === 0) return;
    this.snapshot = {
      ...this.snapshot,
      current: (current + direction + matches.length) % matches.length,
    };
    this.publish();
  }

  private stop() {
    this.generation++;
    this.cancel?.();
    this.cancel = null;
  }

  private search(delay: number) {
    const previous = this.snapshot.matches[this.snapshot.current];
    this.stop();
    const generation = this.generation;
    const { files, query, phase } = this.snapshot;
    if (phase === "closed") return;
    // The Find field is single-line; never let a pasted newline match across diff rows.
    if (!query || /[\r\n]/.test(query)) {
      this.snapshot = { ...this.snapshot, phase: "ready", ...emptyResults() };
      this.publish();
      return;
    }
    this.snapshot = { ...this.snapshot, phase: "searching", ...emptyResults() };
    this.publish();
    const matches: DiffMatch[] = [];
    const iterator = this.scan(files, query);
    const run = () => {
      if (generation !== this.generation) return;
      const started = this.clock.now();
      // Bound both elapsed time and work units, including very long no-match lines.
      for (let steps = 0; steps < 2048; steps++) {
        const step = iterator.next();
        const limited = !step.done && step.value !== null && matches.length === MATCH_LIMIT;
        if (step.done || limited) {
          const preserved = previous
            ? matches.findIndex((match) => sameMatch(match, previous))
            : -1;
          let current = preserved;
          if (current < 0 && matches.length) current = 0;
          this.snapshot = {
            phase: "ready",
            query,
            files,
            matches,
            current,
            limited,
            byLine: indexMatches(matches),
            skippedFiles: files.filter(
              (file) => file.status === "binary" || file.status === "too_large",
            ).length,
          };
          this.cancel = null;
          this.publish();
          return;
        }
        if (step.value) matches.push(step.value);
        if (this.clock.now() - started >= 4) break;
      }
      this.cancel = this.clock.schedule(run, 0);
    };
    this.cancel = this.clock.schedule(run, delay);
  }

  private *scan(files: readonly ParsedDiffFile[], query: string): Generator<DiffMatch | null> {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // RegExp reports original UTF-16 offsets; lowercasing the source can change its length.
    const pattern = new RegExp(escaped, "giu");
    for (const file of files) {
      if (file.status === "binary" || file.status === "too_large") {
        yield null;
        continue;
      }
      const cached = this.cache.get(file);
      if (cached) {
        yield* cached;
        yield null;
        continue;
      }
      const found: DiffMatch[] = [];
      for (const match of scanFile(file, pattern, query.length)) {
        if (match) found.push(match);
        yield match;
      }
      this.cache.set(file, found);
      yield null;
    }
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}

function* scanFile(
  file: ParsedDiffFile,
  pattern: RegExp,
  queryLength: number,
): Generator<DiffMatch | null> {
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (line.type === "header") continue;
      let cursor = 0;
      while (cursor < line.content.length) {
        const boundary = Math.min(line.content.length, cursor + CHUNK_SIZE);
        const text = line.content.slice(cursor, boundary + queryLength);
        pattern.lastIndex = 0;
        let match = pattern.exec(text);
        let next = boundary;
        while (match && cursor + match.index < boundary) {
          const start = cursor + match.index;
          const end = start + match[0].length;
          yield { file, hunkIndex, lineIndex, start, end };
          next = Math.max(next, end);
          match = pattern.exec(text);
        }
        cursor = next;
        yield null;
      }
      yield null;
    }
  }
}

function sameMatch(left: DiffMatch, right: DiffMatch): boolean {
  return (
    left.file === right.file &&
    left.hunkIndex === right.hunkIndex &&
    left.lineIndex === right.lineIndex &&
    left.start === right.start &&
    left.end === right.end
  );
}

function indexMatches(matches: readonly DiffMatch[]): LineMatches {
  const files = new Map<ParsedDiffFile, Map<string, DiffMatch[]>>();
  for (const match of matches) {
    let lines = files.get(match.file);
    if (!lines) {
      lines = new Map();
      files.set(match.file, lines);
    }
    const key = `${match.hunkIndex}:${match.lineIndex}`;
    let row = lines.get(key);
    if (!row) {
      row = [];
      lines.set(key, row);
    }
    row.push(match);
  }
  return files;
}
