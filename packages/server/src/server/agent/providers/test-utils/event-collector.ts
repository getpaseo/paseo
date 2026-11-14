import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";

/**
 * How long a test waits for an event the session never publishes.
 */
const EVENT_TIMEOUT_MS = 4_000;

/**
 * The timers of the test process, taken before a test may replace them.
 *
 * A test that controls the clock replaces the timers of the process, and the
 * guard of the collector has to end even then. The guard is cancelled with
 * the timer that made it: a cancellation from the fake clock does not reach a
 * timer of the real one.
 */
const scheduleTimeout = globalThis.setTimeout;
const cancelTimeout = globalThis.clearTimeout;

export interface EventCollector {
  /** Every event the session published, in the order it published them. */
  readonly events: AgentStreamEvent[];
  /**
   * Waits for the first event that matches.
   *
   * The event is the signal the session sends, so the wait ends when the
   * session has something to say - not when a guess about the clock says it
   * should have said it by now.
   *
   * The search starts at the given position in the list of events, so a test
   * that waits for the turn it just started does not read the end of an
   * earlier one.
   */
  waitFor(match: (event: AgentStreamEvent) => boolean, from?: number): Promise<AgentStreamEvent>;
}

/**
 * Collects the events of a session and lets a test wait for one of them.
 *
 * The collector subscribes once, so it also receives what the session
 * published before the test started listening. An ACP session hands the rows
 * of its delegation tree to its first subscriber; a session that keeps no
 * backlog has nothing to hand over.
 */
export function createEventCollector(session: AgentSession): EventCollector {
  const events: AgentStreamEvent[] = [];
  const waiters: Array<{
    from: number;
    match: (event: AgentStreamEvent) => boolean;
    resolve: (event: AgentStreamEvent) => void;
  }> = [];
  session.subscribe((event) => {
    events.push(event);
    const index = events.length - 1;
    for (let position = waiters.length - 1; position >= 0; position -= 1) {
      const waiter = waiters[position];
      if (index < waiter.from || !waiter.match(event)) {
        continue;
      }
      waiters.splice(position, 1);
      waiter.resolve(event);
    }
  });
  return {
    events,
    waitFor(match, from = 0) {
      const published = events.slice(from).find(match);
      if (published) {
        return Promise.resolve(published);
      }
      return new Promise<AgentStreamEvent>((resolve, reject) => {
        const timer = scheduleTimeout(() => {
          reject(new Error("The session published no event that matches."));
        }, EVENT_TIMEOUT_MS);
        waiters.push({
          from,
          match,
          resolve: (event) => {
            cancelTimeout(timer);
            resolve(event);
          },
        });
      });
    },
  };
}
