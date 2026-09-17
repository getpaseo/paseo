import type { AgentTimelineSearchPayload } from "@getpaseo/client/internal/daemon-client";
import type { StreamItem } from "@/types/stream";

type Location = AgentTimelineSearchPayload["locations"][number];
interface Target {
  id: string;
  seq: number;
  before: number;
}
interface Snapshot {
  open: boolean;
  query: string;
  phase: "idle" | "searching" | "loading" | "ready" | "error";
  selectedItemId: string | null;
  occurrence: number;
  count: number;
  error: string | null;
}
export interface ChatFindOperations {
  search(query: string, cursor?: number): Promise<AgentTimelineSearchPayload>;
  load(epoch: string, seq: number): Promise<unknown>;
  reveal(
    itemId: string,
    query: string,
    occurrence: number,
    signal: AbortSignal,
  ): Promise<{ occurrence: number; count: number }>;
  clear(): void;
}

export class ChatFindModel {
  private state: Snapshot = {
    open: false,
    query: "",
    phase: "idle",
    selectedItemId: null,
    occurrence: 0,
    count: 0,
    error: null,
  };
  private listeners = new Set<() => void>();
  private historyListeners = new Set<() => void>();
  private items: StreamItem[] = [];
  private epoch: string | null = null;
  private resultEpoch: string | null = null;
  private locations: Location[] = [];
  private resolved = new Map<Location, Target>();
  private current = -1;
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private operations: ChatFindOperations) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<Snapshot>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private cancel() {
    this.abort.abort();
    this.abort = new AbortController();
    clearTimeout(this.timer);
    this.operations.clear();
  }
  readonly open = () => {
    if (this.state.open) return;
    this.publish({ open: true });
    if (this.state.query) this.setQuery(this.state.query);
  };
  readonly close = () => {
    this.cancel();
    this.publish({ open: false, phase: "idle", selectedItemId: null, count: 0, error: null });
  };
  readonly setQuery = (query: string) => {
    this.cancel();
    this.locations = [];
    this.resultEpoch = null;
    this.resolved.clear();
    this.current = -1;
    this.publish({
      query,
      phase: query.trim() ? "searching" : "idle",
      selectedItemId: null,
      occurrence: 0,
      count: 0,
      error: null,
    });
    if (!query.trim()) return;
    const signal = this.abort.signal;
    this.timer = setTimeout(() => {
      void this.search(signal);
    }, 120);
  };
  readonly retry = () => this.setQuery(this.state.query);
  private fail(error: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    this.cancel();
    this.publish({
      phase: "error",
      selectedItemId: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  private async search(signal: AbortSignal) {
    try {
      let cursor: number | undefined;
      do {
        const result = await this.operations.search(this.state.query, cursor);
        if (signal.aborted) return;
        const historyChanged = this.epoch !== null && result.epoch !== this.epoch;
        const searchChanged = this.resultEpoch !== null && result.epoch !== this.resultEpoch;
        if (historyChanged || searchChanged) throw new Error("History changed; search again");
        this.resultEpoch = result.epoch;
        this.locations.push(...result.locations);
        cursor = result.nextCursor ?? undefined;
      } while (cursor !== undefined);
      await this.navigate(0, 1, signal);
    } catch (error) {
      this.fail(error, signal);
    }
  }
  updateHistory(epoch: string | null, items: StreamItem[]) {
    if (
      this.resultEpoch !== null &&
      epoch !== null &&
      epoch !== this.resultEpoch &&
      this.state.open
    ) {
      this.fail(new Error("History changed; search again"), this.abort.signal);
    }
    this.epoch = epoch;
    this.items = items;
    this.historyListeners.forEach((listener) => listener());
  }
  private target(location: Location, exact: boolean): Target | null {
    let before = 0;
    for (const item of this.items) {
      if (item.timelineCursor?.epoch !== this.resultEpoch) continue;
      const seq = item.timelineCursor.seq;
      if (seq < location.seq) {
        before = Math.max(before, seq);
        continue;
      }
      const sameRole = item.kind === `${location.role}_message`;
      if (sameRole && (!exact || seq === location.seq)) return { id: item.id, seq, before };
      // A prompt is a hard boundary; never resolve an assistant hit in a later response.
      if (item.kind === "user_message") return null;
    }
    return null;
  }
  private waitForTarget(location: Location, signal: AbortSignal): Promise<Target> {
    return new Promise((resolve, reject) => {
      const finish = (target?: Target) => {
        clearTimeout(timeout);
        this.historyListeners.delete(check);
        signal.removeEventListener("abort", cancelled);
        if (target) resolve(target);
        else reject(new Error("Could not load this search location; retry"));
      };
      const check = () => {
        const target = this.target(location, false);
        if (target) finish(target);
      };
      const cancelled = () => finish();
      const timeout = setTimeout(() => finish(), 5000);
      this.historyListeners.add(check);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else check();
    });
  }
  private async navigate(index: number, direction: 1 | -1, signal: AbortSignal) {
    const epoch = this.resultEpoch;
    if (epoch === null) return;
    this.publish({ phase: "loading", error: null });
    let remaining = this.locations.length;
    while (remaining-- > 0 && this.locations.length) {
      index = (index + this.locations.length) % this.locations.length;
      const location = this.locations[index]!;
      const cached = this.resolved.get(location);
      const stillLoaded =
        cached &&
        this.items.some((item) => item.id === cached.id && item.timelineCursor?.seq === cached.seq);
      let target = stillLoaded ? cached : this.target(location, true);
      if (!target) {
        await this.operations.load(epoch, location.seq);
        if (signal.aborted) return;
        target = await this.waitForTarget(location, signal);
      }
      if (signal.aborted) return;
      this.resolved.set(location, target);
      // Multiple source hits may belong to the same displayed message. Resolve that
      // here, using loaded client rows, without changing the timeline's data model.
      this.locations = this.locations.filter(
        (candidate) =>
          candidate === location ||
          candidate.role !== location.role ||
          candidate.seq <= target.before ||
          candidate.seq > target.seq,
      );
      index = this.locations.indexOf(location);
      this.publish({ selectedItemId: target.id });
      const result = await this.operations.reveal(
        target.id,
        this.state.query,
        direction === 1 ? 0 : -1,
        signal,
      );
      if (signal.aborted) return;
      if (result.count) {
        this.current = index;
        this.publish({ phase: "ready", ...result });
        return;
      }
      this.locations.splice(index, 1);
      if (direction === -1) index--;
    }
    this.operations.clear();
    this.publish({ phase: "ready", selectedItemId: null, count: 0, occurrence: 0 });
  }
  private async move(direction: 1 | -1) {
    if (this.state.phase !== "ready" || !this.state.count) return;
    this.cancel();
    const signal = this.abort.signal;
    try {
      const occurrence = this.state.occurrence + direction;
      if (occurrence >= 0 && occurrence < this.state.count && this.state.selectedItemId) {
        this.publish({ phase: "loading" });
        const result = await this.operations.reveal(
          this.state.selectedItemId,
          this.state.query,
          occurrence,
          signal,
        );
        if (signal.aborted) return;
        if (result.count) {
          this.publish({ phase: "ready", ...result });
          return;
        }
      }
      await this.navigate(this.current + direction, direction, signal);
    } catch (error) {
      this.fail(error, signal);
    }
  }
  readonly next = () => {
    void this.move(1);
  };
  readonly previous = () => {
    void this.move(-1);
  };
}
