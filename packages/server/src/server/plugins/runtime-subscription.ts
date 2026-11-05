/** Receives a plugin subscription's events once its owner attached. */
export interface PluginSubscriptionSink {
  event(event: unknown): void;
  /** The plugin ended the subscription, or stopped. Not called after `release()`. */
  closed(error?: string): void;
}

/** A started plugin subscription, from the daemon's side of the subprocess. */
export interface PluginRuntimeSubscription {
  /** Resolves when the plugin acknowledged; rejects when it refused. */
  readonly ready: Promise<void>;
  /** Delivers what arrived so far, then everything that follows. */
  attach(sink: PluginSubscriptionSink): void;
  release(): void;
}

type Pending = { type: "event"; event: unknown } | { type: "closed"; error?: string };

/**
 * Holds events until the owner attaches, so the owner can answer the subscribe request before
 * the first event goes out.
 */
export class BufferedPluginSubscription {
  private sink: PluginSubscriptionSink | null = null;
  private pending: Pending[] = [];
  private ended = false;

  attach(sink: PluginSubscriptionSink): void {
    if (this.sink) throw new Error("Plugin subscription is already attached");
    this.sink = sink;
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      if (entry.type === "event") sink.event(entry.event);
      else sink.closed(entry.error);
    }
  }

  event(event: unknown): void {
    if (this.ended) return;
    if (this.sink) this.sink.event(event);
    else this.pending.push({ type: "event", event });
  }

  closed(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.sink) this.sink.closed(error);
    else this.pending.push({ type: "closed", ...(error === undefined ? {} : { error }) });
  }

  released(): void {
    this.ended = true;
    this.pending = [];
  }
}
