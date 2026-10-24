import { getDesktopHost } from "@/desktop/host";
import { createNotificationOpenSource as createWebSource } from "./source.web";
import type { NotificationOpenSource } from "./source";

export function createNotificationOpenSource(): NotificationOpenSource {
  const web = createWebSource();
  let nextId = 0;
  return {
    ...web,
    subscribe(onTap) {
      const stopWeb = web.subscribe(onTap);
      let disposed = false;
      let stopDesktop: (() => void) | undefined;
      const subscription = getDesktopHost()?.events?.on?.(
        "notification-click",
        (payload: unknown) => {
          const data =
            typeof payload === "object" && payload !== null && "data" in payload
              ? payload.data
              : undefined;
          onTap({
            id: `electron:${++nextId}`,
            data:
              typeof data === "object" && data !== null
                ? Object.fromEntries(Object.entries(data))
                : undefined,
          });
        },
      );
      void Promise.resolve(subscription).then((stop) => {
        if (disposed) stop?.();
        else stopDesktop = stop;
        return;
      });
      return () => {
        disposed = true;
        stopWeb();
        stopDesktop?.();
      };
    },
  };
}
