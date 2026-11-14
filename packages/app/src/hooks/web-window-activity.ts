import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import type { ClientActivityTracker } from "./client-activity-tracker";

export type WebWindowEvent =
  | "visibilitychange"
  | "focus"
  | "blur"
  | "pointerdown"
  | "keydown"
  | "wheel"
  | "touchstart";

export interface WebWindowPort {
  isActivelyVisible(): boolean;
  subscribe(event: WebWindowEvent, listener: () => void): () => void;
}

const USER_ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const PASSIVE_EVENTS: ReadonlySet<WebWindowEvent> = new Set(["pointerdown", "wheel", "touchstart"]);

export function createBrowserWindowPort(): WebWindowPort {
  return {
    isActivelyVisible: () => getIsAppActivelyVisible(),
    subscribe(event, listener) {
      const target: EventTarget = event === "visibilitychange" ? document : window;
      target.addEventListener(
        event,
        listener,
        PASSIVE_EVENTS.has(event) ? { passive: true } : undefined,
      );
      return () => target.removeEventListener(event, listener);
    },
  };
}

export function bindWebWindowActivity(
  tracker: ClientActivityTracker,
  port: WebWindowPort,
): () => void {
  const handleUserActivity = () => {
    tracker.recordUserActivity();
    tracker.maybeSendImmediateHeartbeat();
  };

  const handleVisibilityChange = () => {
    tracker.notifyAppVisibility(port.isActivelyVisible());
  };

  const handleWindowFocus = () => {
    handleVisibilityChange();
    handleUserActivity();
  };

  handleVisibilityChange();
  const unsubscribes = [
    port.subscribe("visibilitychange", handleVisibilityChange),
    port.subscribe("focus", handleWindowFocus),
    port.subscribe("blur", handleVisibilityChange),
    ...USER_ACTIVITY_EVENTS.map((event) => port.subscribe(event, handleUserActivity)),
  ];

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
