import { WEB_NOTIFICATION_CLICK_EVENT } from "./model";
import type { NotificationOpenSource } from "./source";
import { isWeb } from "@/constants/platform";

export function createNotificationOpenSource(): NotificationOpenSource {
  let nextId = 0;
  return {
    subscribe(onTap) {
      if (!isWeb) return () => {};
      function receive(event: Event) {
        if (!(event instanceof CustomEvent)) return;
        event.preventDefault();
        onTap({ id: `web:${++nextId}`, data: event.detail?.data });
      }
      window.addEventListener(WEB_NOTIFICATION_CLICK_EVENT, receive);
      return () => window.removeEventListener(WEB_NOTIFICATION_CLICK_EVENT, receive);
    },
    async takeLaunchTap() {
      return null;
    },
    acknowledge() {},
  };
}
