import { useEffect } from "react";
import { getIsElectronRuntime } from "@/constants/layout";
import { getDesktopHost } from "@/desktop/host";
import {
  ensureOsNotificationPermission,
  WEB_NOTIFICATION_CLICK_EVENT,
  type WebNotificationClickDetail,
} from "@/utils/os-notifications";

type OpenNotification = (data: Record<string, unknown> | undefined) => void;

/** Browser / Electron notification click → in-app navigation. */
export function useNotificationOpenListener(openNotification: OpenNotification): void {
  useEffect(() => {
    let removeDesktopNotificationListener: (() => void) | null = null;
    let cancelled = false;

    if (getIsElectronRuntime()) {
      void ensureOsNotificationPermission();

      const unlistenResult = getDesktopHost()?.events?.on?.(
        "notification-click",
        (payload: unknown) => {
          const data =
            typeof payload === "object" &&
            payload !== null &&
            "data" in payload &&
            typeof (payload as { data?: unknown }).data === "object" &&
            (payload as { data?: unknown }).data !== null
              ? (payload as { data: Record<string, unknown> }).data
              : undefined;
          openNotification(data);
        },
      );

      void Promise.resolve(unlistenResult).then((unlisten) => {
        if (typeof unlisten !== "function") {
          return;
        }
        if (cancelled) {
          unlisten();
          return;
        }
        removeDesktopNotificationListener = unlisten;
        return;
      });
    }

    const openFromWebClick = (event: Event) => {
      const customEvent = event as CustomEvent<WebNotificationClickDetail>;
      event.preventDefault();
      openNotification(customEvent.detail?.data);
    };

    window.addEventListener(WEB_NOTIFICATION_CLICK_EVENT, openFromWebClick as EventListener);

    return () => {
      cancelled = true;
      removeDesktopNotificationListener?.();
      window.removeEventListener(WEB_NOTIFICATION_CLICK_EVENT, openFromWebClick as EventListener);
    };
  }, [openNotification]);
}
