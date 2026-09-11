import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { FetchAgentTimelinePayload } from "../daemon-client.js";
import type { OwnedSubscription, TimelineSubscription } from "../connection/index.js";

type TimelineUpdate = Extract<
  SessionOutboundMessage,
  { type: "agent_stream" | "agent.timeline.replacement" }
>;

/** Local SDK recovery messages; these are not additional wire RPCs. */
export type TimelineMessage =
  | TimelineUpdate
  | {
      type: "agent.timeline.snapshot";
      payload: { agentId: string; subscriptionId: string; page: FetchAgentTimelinePayload };
    }
  | { type: "agent.timeline.error"; payload: { agentId: string; error: string } };

const MAX_RECOVERY_UPDATES = 128;

/** A live-only initial observation, with a fresh bounded history view after each outage. */
export function subscribeTimeline(
  agentId: string,
  observation: OwnedSubscription<{ agentIds: string[] }>,
  readSnapshot: () => Promise<FetchAgentTimelinePayload>,
  handler: (message: TimelineMessage) => void,
  reportError: (error: unknown) => void,
): TimelineSubscription {
  let established = false;
  let released = false;
  interface Recovery {
    id: string;
    revision: number;
    updates: TimelineUpdate[];
    replacement?: Extract<TimelineUpdate, { type: "agent.timeline.replacement" }>;
  }
  let recovery: Recovery | null = null;
  const current = (state: Recovery) =>
    !released && recovery === state && observation.subscriptionId === state.id;
  const notify = (message: TimelineMessage) => {
    if (released) return;
    try {
      handler(message);
    } catch (error) {
      reportError(error);
    }
  };
  const release = () => {
    released = true;
    recovery = null;
    return observation.release();
  };
  const stop = () => {
    // Use the public release entry point so the owning API also forgets this handle.
    void subscription.release().catch(reportError);
  };
  const fail = (error: unknown) => {
    notify({
      type: "agent.timeline.error",
      payload: { agentId, error: error instanceof Error ? error.message : String(error) },
    });
    stop();
  };
  const recover = async (state: Recovery) => {
    while (current(state)) {
      const revision = state.revision;
      let page: FetchAgentTimelinePayload;
      try {
        page = await readSnapshot();
      } catch (error) {
        if (current(state)) fail(error);
        return;
      }
      if (!current(state)) return;
      // Overflow or replacement makes this in-flight read obsolete. Read a fresh
      // bounded page instead of retaining an unbounded backlog of transient events.
      if (revision !== state.revision) continue;
      if (state.replacement) notify(state.replacement);
      if (!current(state)) return;
      notify({
        type: "agent.timeline.snapshot",
        payload: { agentId, subscriptionId: state.id, page },
      });
      if (!current(state)) return;
      recovery = null;
      for (const message of state.updates) {
        if (released || observation.subscriptionId !== state.id) break;
        if (message.type === "agent_stream" && typeof message.payload.seq === "number") {
          if (
            message.payload.epoch !== page.epoch ||
            message.payload.seq <= (page.window.maxSeq ?? 0)
          )
            continue;
        }
        notify(message);
      }
    }
  };
  observation.subscribe({
    snapshot: ({ subscriptionId }) => {
      if (!established) {
        established = true;
        return;
      }
      const state: Recovery = { id: subscriptionId, revision: 0, updates: [] };
      recovery = state;
      void recover(state);
    },
    update: (message) => {
      if (message.type !== "agent_stream" && message.type !== "agent.timeline.replacement") return;
      if (!recovery) return notify(message);
      if (message.type === "agent.timeline.replacement") {
        recovery.replacement = message;
        recovery.revision++;
        recovery.updates.length = 0;
      } else {
        if (recovery.updates.length === MAX_RECOVERY_UPDATES) {
          recovery.revision++;
          recovery.updates.length = 0;
        }
        recovery.updates.push(message);
      }
    },
    error: fail,
  });
  const subscription: TimelineSubscription = Object.assign(stop, {
    ready: observation.ready.then(() => undefined),
    release,
    subscriptionId: null,
  });
  Object.defineProperty(subscription, "subscriptionId", { get: () => observation.subscriptionId });
  void subscription.ready.catch(fail);
  return subscription;
}
