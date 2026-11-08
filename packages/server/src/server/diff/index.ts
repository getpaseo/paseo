import { TOTAL_DIFF_MAX_BYTES } from "../../utils/checkout-git.js";
import { DEFAULT_MAX_OUTPUT_BYTES, runGitCommand } from "../../utils/run-git-command.js";
import { expandTilde, createRealpathAwarePathMatcher } from "../../utils/path.js";
import { packBodies } from "./batches.js";
import { setImmediate } from "node:timers/promises";
import {
  DiffOpcode,
  materializeDiffFile,
  type DiffFrame,
  type DiffEntry,
  type DiffBody,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  DiffError,
  DiffEndpoint,
  ParsedDiffFile,
  CheckoutCommitFileDiffRequest,
} from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import {
  listComparison,
  validateCompare,
  worktreeRoot,
  DiffReadError,
  type Compare,
  type Comparison,
} from "./git.js";
import { DiffDependencyObserver } from "./dependencies.js";

interface RecordCache {
  identity: string;
  body: DiffBody;
  bytes: number;
}
interface Listener {
  emit(frame: DiffFrame): Promise<void>;
  active: boolean;
  delivery: Promise<void>;
}
interface Target {
  key: string;
  compare: Compare;
  listeners: Set<Listener>;
  revision: number;
  committed: number;
  cache: Map<string, RecordCache>;
  entries: DiffEntry[];
  resolved: Pick<Comparison, "baseSha" | "headSha" | "mergeBaseSha">;
  error: DiffError | null;
  omitted: string[];
  refresh: Promise<void> | null;
  dirty: boolean;
  checkInterpretation: (() => Promise<boolean>) | null;
  interpretationCheck: Promise<void> | null;
  interpretationDirty: boolean;
  release: (() => Promise<void>) | null;
  opening: Promise<void> | null;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
export interface CommitFileRead extends Pick<
  CheckoutCommitFileDiffRequest,
  "cwd" | "sha" | "path"
> {
  signal?: AbortSignal;
}
export interface DiffSubscription {
  start(): Promise<void>;
  release(): Promise<void>;
}
export class DiffSubscriptions {
  private targets = new Map<string, Target>();
  private dependencies: DiffDependencyObserver;
  private computations = 0;
  private highlightCalls = 0;
  constructor(workspaceGit: Pick<WorkspaceGitService, "requestWorkingTreeWatch">) {
    this.dependencies = new DiffDependencyObserver(workspaceGit);
  }
  getMetrics() {
    return {
      targets: this.targets.size,
      subscriptions: [...this.targets.values()].reduce(
        (sum, target) => sum + target.listeners.size,
        0,
      ),
      computations: this.computations,
      highlightCalls: this.highlightCalls,
      metadataObservers: this.dependencies.getObservationCount(),
    };
  }
  async readCommitFile(input: CommitFileRead): Promise<ParsedDiffFile | null> {
    input.signal?.throwIfAborted();
    const cwd = await worktreeRoot(expandTilde(input.cwd));
    const result = await runGitCommand(
      ["rev-list", "--parents", "--max-count=1", "--end-of-options", input.sha],
      { cwd },
    );
    const [head, parent] = result.stdout.trim().split(" ");
    if (!head) throw new DiffReadError("REF_NOT_FOUND", `Revision not found: ${input.sha}`);
    const base: DiffEndpoint = parent ? { kind: "rev", rev: parent } : { kind: "empty" };
    const comparison = await listComparison({ cwd, base, head: { kind: "rev", rev: head } });
    try {
      input.signal?.throwIfAborted();
      const file = comparison.files.find((candidate) => candidate.entry.path === input.path);
      if (!file || file.entry.content === "binary") return null;
      comparison.selectBodies(new Set([file.entry.path]));
      const record = await comparison.read(file, { maxPatchBytes: DEFAULT_MAX_OUTPUT_BYTES });
      input.signal?.throwIfAborted();
      return materializeDiffFile(
        file.entry,
        record.kind === "ready" ? record.body : null,
        record.kind === "too_large",
      );
    } finally {
      await comparison.close();
    }
  }
  async subscribe(compare: Compare, emit: Listener["emit"]): Promise<DiffSubscription> {
    validateCompare(compare);
    compare = {
      ...compare,
      cwd: await worktreeRoot(expandTilde(compare.cwd)),
      mergeBase: compare.mergeBase === true,
      ignoreWhitespace: compare.ignoreWhitespace === true,
      highlight: compare.highlight !== false,
    };
    const key = JSON.stringify([
      compare.cwd,
      compare.checkoutBase
        ? ["checkout", JSON.stringify(compare.checkoutBase)]
        : endpointKey(compare.base),
      endpointKey(compare.head),
      compare.mergeBase,
      compare.ignoreWhitespace,
      compare.highlight,
    ]);
    let target = this.targets.get(key);
    if (!target) {
      target = {
        key,
        compare,
        listeners: new Set(),
        revision: 0,
        committed: 0,
        cache: new Map(),
        entries: [],
        resolved: { baseSha: "", headSha: "", mergeBaseSha: "" },
        error: null,
        omitted: [],
        refresh: null,
        dirty: false,
        checkInterpretation: null,
        interpretationCheck: null,
        interpretationDirty: false,
        release: null,
        opening: null,
        closed: false,
        timer: null,
      };
      this.targets.set(key, target);
      const captured = target;
      try {
        target.opening = this.dependencies
          .declareDependencies(
            {
              cwd: compare.cwd,
              refs: [compare.base, compare.head].flatMap((endpoint) =>
                endpoint.kind === "rev" && !/^[a-f0-9]{40,64}$/.test(endpoint.rev)
                  ? [endpoint.rev]
                  : [],
              ),
              index: compare.base.kind === "index" || compare.head.kind !== "rev",
              worktree: compare.head.kind === "worktree",
            },
            (kind) => {
              if (kind === "interpretation") this.invalidateInterpretation(captured);
              else this.invalidate(captured);
            },
          )
          .then((release) => {
            captured.release = release;
            return undefined;
          });
      } catch (error) {
        this.targets.delete(key);
        throw error;
      }
    }
    try {
      await target.opening;
    } catch (error) {
      target.closed = true;
      this.targets.delete(key);
      throw error;
    }
    if (target.closed) throw new Error("Diff subscription cancelled");
    const current = target;
    const listener: Listener = { emit, active: false, delivery: Promise.resolve() };
    current.listeners.add(listener);
    let released = false;
    return {
      start: async () => {
        while (current.refresh) await current.refresh;
        if (current.closed || released) return;
        listener.active = true;
        if (!current.committed) await this.refresh(current);
        else {
          const replay = this.replay(current, listener);
          listener.delivery = replay.catch(() => {});
          await replay;
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        listener.active = false;
        current.listeners.delete(listener);
        if (current.listeners.size) return;
        current.closed = true;
        if (current.timer) clearTimeout(current.timer);
        this.targets.delete(key);
        await current.release?.();
        await current.refresh;
        await current.interpretationCheck;
      },
    };
  }
  async invalidateForCwd(cwd: string): Promise<void> {
    let root: string;
    try {
      root = await worktreeRoot(expandTilde(cwd));
    } catch (error) {
      if (error instanceof DiffReadError && error.code === "NOT_GIT_REPO") return;
      throw error;
    }
    const matches = createRealpathAwarePathMatcher(root);
    for (const target of this.targets.values())
      if (matches(target.compare.cwd)) this.invalidate(target);
  }
  private invalidateInterpretation(target: Target): void {
    if (target.closed) return;
    target.interpretationDirty = true;
    target.interpretationCheck ??= this.checkInterpretation(target).finally(() => {
      target.interpretationCheck = null;
    });
  }
  private async checkInterpretation(target: Target): Promise<void> {
    do {
      target.interpretationDirty = false;
      try {
        if (!target.checkInterpretation || (await target.checkInterpretation())) {
          this.invalidate(target);
          return;
        }
      } catch {
        // A normal revision owns error delivery and recovery.
        this.invalidate(target);
        return;
      }
    } while (target.interpretationDirty && !target.closed);
  }
  private invalidate(target: Target): void {
    if (target.closed) return;
    target.dirty = true;
    if (target.listeners.size === 0) return;
    if (target.timer) clearTimeout(target.timer);
    target.timer = setTimeout(() => {
      target.timer = null;
      void this.refresh(target);
    }, 150);
  }
  private async emit(target: Target, frame: DiffFrame): Promise<void> {
    await Promise.all(
      [...target.listeners]
        .filter((listener) => listener.active)
        .map((listener) => {
          const sent = listener.delivery.then(() => listener.emit(frame));
          listener.delivery = sent.catch(() => {});
          return sent;
        }),
    );
    await setImmediate();
  }
  private async replay(target: Target, listener: Listener): Promise<void> {
    const entries = target.entries.map((entry) => ({ ...entry, body: entry.content !== "binary" }));
    await listener.emit({
      opcode: DiffOpcode.Begin,
      slot: 0,
      revision: target.committed,
      baseRevision: 0,
      ...target.resolved,
      entries,
    });
    const bodies: DiffBody[] = [];
    for (const entry of entries) {
      const cached = target.cache.get(entry.path);
      if (entry.body && cached) bodies.push(cached.body);
    }
    for await (const files of packBodies(bodies, target.committed)) {
      await listener.emit({
        opcode: DiffOpcode.Bodies,
        slot: 0,
        revision: target.committed,
        files,
      });
      await setImmediate();
    }
    await listener.emit({
      opcode: DiffOpcode.End,
      slot: 0,
      revision: target.committed,
      diffTooLarge: target.omitted.length > 0,
      omitted: target.omitted,
      error: target.error,
    });
  }
  private async refresh(target: Target): Promise<void> {
    if (target.refresh || target.closed) return target.refresh ?? undefined;
    target.refresh = this.run(target).finally(() => {
      target.refresh = null;
    });
    return target.refresh;
  }
  private async run(target: Target): Promise<void> {
    do {
      target.dirty = false;
      const revision = ++target.revision;
      let comparison: Comparison | null = null;
      let began = false;
      try {
        this.computations++;
        comparison = await listComparison(target.compare);
        target.checkInterpretation = comparison.hasInterpretationChanged;
        const resolved = {
          baseSha: comparison.baseSha,
          headSha: comparison.headSha,
          mergeBaseSha: comparison.mergeBaseSha,
        };
        const tooManyFiles = comparison.files.length > 10000;
        const entries = comparison.files.map((file) => ({
          ...file.entry,
          body: tooManyFiles
            ? file.entry.content === "text"
            : needsBody(target, file.entry, file.identity),
        }));
        await this.emit(target, {
          opcode: DiffOpcode.Begin,
          slot: 0,
          revision,
          baseRevision: target.error ? 0 : target.committed,
          ...resolved,
          entries,
        });
        began = true;
        const cache = new Map<string, RecordCache>();
        const omitted: string[] = [];
        const state = { cache, omitted, total: 0 };
        const records = this.readBodies(target, comparison, entries, state);
        for await (const files of packBodies(records, revision)) {
          if (isInterrupted(target)) break;
          await this.emit(target, { opcode: DiffOpcode.Bodies, slot: 0, revision, files });
        }
        if (isInterrupted(target)) continue;
        await this.emit(target, {
          opcode: DiffOpcode.End,
          slot: 0,
          revision,
          omitted,
          diffTooLarge: omitted.length > 0,
          error: null,
        });
        target.committed = revision;
        target.resolved = resolved;
        target.entries = entries;
        target.cache = cache;
        target.omitted = omitted;
        target.error = null;
      } catch (error) {
        const failure = diffError(error);
        if (!began)
          await this.emit(target, {
            opcode: DiffOpcode.Begin,
            slot: 0,
            revision,
            baseRevision: 0,
            baseSha: "",
            headSha: "",
            mergeBaseSha: "",
            entries: [],
          });
        await this.emit(target, {
          opcode: DiffOpcode.End,
          slot: 0,
          revision,
          diffTooLarge: false,
          omitted: [],
          error: failure,
        });
        target.error = failure;
        target.committed = revision;
        target.entries = [];
        target.cache.clear();
        target.omitted = [];
      } finally {
        if (comparison) this.highlightCalls += comparison.metrics.highlightCalls;
        await comparison?.close();
      }
    } while (target.dirty && !target.closed);
  }
  private async *readBodies(
    target: Target,
    comparison: Comparison,
    entries: DiffEntry[],
    state: { cache: Map<string, RecordCache>; omitted: string[]; total: number },
  ): AsyncGenerator<DiffBody> {
    if (entries.length > 10000) {
      for (const entry of entries) if (entry.content === "text") state.omitted.push(entry.path);
      return;
    }
    comparison.selectBodies(
      new Set(entries.filter((entry) => entry.body).map((entry) => entry.path)),
    );
    for (let index = 0; index < comparison.files.length; index++) {
      if (isInterrupted(target)) return;
      const file = comparison.files[index];
      const entry = entries[index];
      if (entry.content === "binary") continue;
      let record = target.cache.get(entry.path);
      if (entry.body || !record) {
        const read = await comparison.read(file, {
          remainingBytes: TOTAL_DIFF_MAX_BYTES - state.total,
        });
        if (read.kind === "too_large") {
          state.omitted.push(entry.path);
          continue;
        }
        record = { identity: file.identity, body: read.body, bytes: read.bytes };
      }
      if (exceedsBudget(state.total, record.bytes)) {
        state.omitted.push(entry.path);
        continue;
      }
      state.total += record.bytes;
      state.cache.set(entry.path, record);
      if (entry.body) yield record.body;
    }
  }
  async close(): Promise<void> {
    for (const target of this.targets.values()) {
      target.closed = true;
      if (target.timer) clearTimeout(target.timer);
      await target.opening;
      await target.release?.();
      await target.refresh;
      await target.interpretationCheck;
    }
    this.targets.clear();
    await this.dependencies.close();
  }
}

function isInterrupted(target: Target): boolean {
  return target.closed || target.dirty;
}
function exceedsBudget(total: number, bytes: number): boolean {
  return total + bytes > TOTAL_DIFF_MAX_BYTES;
}
function needsBody(target: Target, entry: DiffEntry, identity: string): boolean {
  return (
    entry.content === "text" &&
    (target.error !== null || target.cache.get(entry.path)?.identity !== identity)
  );
}

function diffError(error: unknown): DiffError {
  return {
    code: error instanceof DiffReadError ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  };
}

export { DiffSession } from "./session.js";

function endpointKey(endpoint: DiffEndpoint): string[] {
  if (endpoint.kind === "rev") return [endpoint.kind, endpoint.rev];
  return [endpoint.kind];
}
