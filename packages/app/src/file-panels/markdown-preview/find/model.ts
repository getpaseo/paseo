/** What the rendered document does for Find; the model owns query and position. */
export interface MarkdownFindView<Match> {
  search(query: string): Match[];
  /** Paint every match, mark `current`, and scroll it into view when `reveal` is set. */
  show(matches: readonly Match[], current: number, reveal: boolean): void;
  clear(): void;
}

export interface MarkdownFindSnapshot {
  open: boolean;
  query: string;
  /** Zero-based index of the active match, or -1 when there is none. */
  current: number;
  total: number;
}

export class MarkdownFindModel<Match> {
  private listeners = new Set<() => void>();
  private matches: Match[] = [];
  private snapshot: MarkdownFindSnapshot = { open: false, query: "", current: -1, total: 0 };

  constructor(private readonly view: MarkdownFindView<Match>) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;

  /** Reopening keeps the last query and lands on its first match. */
  readonly open = () => {
    if (this.snapshot.open) return;
    this.snapshot = { ...this.snapshot, open: true };
    this.search(0, true);
  };
  readonly close = () => {
    if (!this.snapshot.open) return;
    this.matches = [];
    this.view.clear();
    this.snapshot = { ...this.snapshot, open: false, current: -1, total: 0 };
    this.publish();
  };
  readonly setQuery = (query: string) => {
    this.snapshot = { ...this.snapshot, query };
    this.search(0, true);
  };
  readonly next = () => this.step(1);
  readonly previous = () => this.step(-1);

  /** The document re-rendered: recount, stay on the same index, and leave the scroll alone. */
  readonly refresh = () => {
    if (this.snapshot.open) this.search(this.snapshot.current, false);
  };

  private step(delta: number) {
    const total = this.matches.length;
    if (!this.snapshot.open || total === 0) return;
    const current = (this.snapshot.current + delta + total) % total;
    this.snapshot = { ...this.snapshot, current };
    this.view.show(this.matches, current, true);
    this.publish();
  }

  private search(preferred: number, reveal: boolean) {
    if (!this.snapshot.open) {
      this.publish();
      return;
    }
    this.matches = this.view.search(this.snapshot.query);
    const total = this.matches.length;
    const current = total === 0 ? -1 : Math.min(Math.max(preferred, 0), total - 1);
    this.snapshot = { ...this.snapshot, current, total };
    if (total === 0) this.view.clear();
    else this.view.show(this.matches, current, reveal);
    this.publish();
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
