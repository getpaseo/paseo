import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { OwnedSubscription, TimelineSubscription } from "../connection/index.js";

type TimelineUpdate = Extract<
  SessionOutboundMessage,
  { type: "agent_stream" | "agent.timeline.replacement" }
>;

/** Local SDK lifecycle messages; these are not additional wire RPCs. */
export type TimelineMessage =
  | TimelineUpdate
  | {
      type: "agent.timeline.subscription_restored";
      payload: { agentId: string; subscriptionId: string };
    }
  | { type: "agent.timeline.error"; payload: { agentId: string; error: string } };

/** Restores live delivery; the consumer owns history reads and gap recovery. */
export function subscribeTimeline(
  agentId: string,
  observation: OwnedSubscription<{ agentIds: string[] }>,
  handler: (message: TimelineMessage) => void,
  reportError: (error: unknown) => void,
): TimelineSubscription {
  let established = false;
  let released = false;
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
  observation.subscribe({
    snapshot: ({ subscriptionId }) => {
      if (!established) {
        established = true;
        return;
      }
      notify({
        type: "agent.timeline.subscription_restored",
        payload: { agentId, subscriptionId },
      });
    },
    update: (message) => {
      if (message.type === "agent_stream" || message.type === "agent.timeline.replacement")
        notify(message);
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
