const escape = String.fromCharCode(27);
const enhancedEnter = new RegExp(`${escape}\\[(?:13(?:;[0-9:]+)*u|27;[0-9]+;13~)`, "g");

/** Serializes asynchronous paste gestures with input, without blocking output or resize. */
export class TerminalPasteQueue {
  private pending: Array<
    | { kind: "input"; send: (failed: boolean) => void }
    | {
        kind: "paste";
        run: (signal: AbortSignal) => Promise<boolean>;
        resolve: (ok: boolean) => void;
      }
  > = [];
  private active: { abort: AbortController; finish: (ok: boolean) => void } | undefined;

  constructor(
    private readonly options: {
      timeoutMs?: number;
      schedule?: (callback: () => void, milliseconds: number) => () => void;
      onFailure?: () => void;
    } = {},
  ) {}

  input(data: string, send: (data: string) => void): void {
    // Ctrl+C explicitly cancels the pending paste, including queued image gestures.
    if (data.includes("\x03")) this.cancel();
    this.action((failed) => {
      const safe = failed ? data.replace(/[\r\n]/g, "").replace(enhancedEnter, "") : data;
      if (safe) send(safe);
    });
  }

  action(send: (failed: boolean) => void): void {
    if (this.active) this.pending.push({ kind: "input", send });
    else send(false);
  }

  paste(run: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending.push({ kind: "paste", run, resolve });
      this.drain();
    });
  }

  cancel(): void {
    for (const entry of this.pending) if (entry.kind === "paste") entry.resolve(false);
    this.pending = this.pending.filter((entry) => entry.kind === "input");
    this.active?.abort.abort();
    this.active?.finish(false);
  }

  dispose(): void {
    for (const entry of this.pending) if (entry.kind === "paste") entry.resolve(false);
    this.pending = [];
    this.active?.abort.abort();
    this.active?.finish(false);
  }

  private drain(): void {
    if (this.active) return;
    const next = this.pending.shift();
    if (!next) return;
    if (next.kind === "input") {
      next.send(false);
      this.drain();
      return;
    }
    const abort = new AbortController();
    let settled = false;
    let clear = () => {};
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clear();
      if (!ok) {
        abort.abort();
        // Preserve typed text, but never submit a prompt after a failed paste.
        this.pending = this.pending.map((entry) =>
          entry.kind === "input" ? { kind: "input", send: () => entry.send(true) } : entry,
        );
        this.options.onFailure?.();
      }
      this.active = undefined;
      next.resolve(ok);
      this.drain();
    };
    this.active = { abort, finish };
    const schedule =
      this.options.schedule ??
      ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      });
    clear = schedule(() => finish(false), this.options.timeoutMs ?? 30_000);
    try {
      void next.run(abort.signal).then(finish, () => finish(false));
    } catch {
      finish(false);
    }
  }
}
