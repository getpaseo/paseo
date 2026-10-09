import type { OwnedSubscription, SubscriptionObserver } from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

/** Public observation dependency for the directory/host runtime tests. */
export function subscriptionFixture<T>(
  snapshot: Promise<T>,
  listen: (receive: (message: SessionOutboundMessage) => void) => () => void,
): OwnedSubscription<T> {
  const subscriptionId = crypto.randomUUID();
  const observers = new Set<SubscriptionObserver<T & { subscriptionId: string }>>();
  const updates: SessionOutboundMessage[] = [];
  let current: (T & { subscriptionId: string }) | undefined;
  let released = false;
  const stop = listen((message) => {
    if (!current) updates.push(message);
    else for (const observer of observers) observer.update(message);
  });
  const ready = snapshot.then((value) => {
    current = { ...value, subscriptionId };
    if (!released) {
      for (const observer of observers) {
        observer.snapshot(current);
        for (const message of updates) observer.update(message);
      }
    }
    return current;
  });
  return {
    subscriptionId,
    ready,
    subscribe(observer) {
      if (released) return () => {};
      observers.add(observer);
      if (current) observer.snapshot(current);
      return () => observers.delete(observer);
    },
    async release() {
      released = true;
      observers.clear();
      stop();
    },
  };
}
