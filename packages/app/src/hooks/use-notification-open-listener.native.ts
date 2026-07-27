import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";

type OpenNotification = (data: Record<string, unknown> | undefined) => void;

/** Native OS notification tap → in-app navigation. */
export function useNotificationOpenListener(openNotification: OpenNotification): void {
  const lastHandledIdRef = useRef<string | null>(null);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        // When the app is open, don't show OS banners.
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    const openFromResponse = (response: Notifications.NotificationResponse) => {
      const identifier = response.notification.request.identifier;
      if (lastHandledIdRef.current === identifier) {
        return;
      }
      lastHandledIdRef.current = identifier;

      const data = response.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      openNotification(data);
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(openFromResponse);

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        openFromResponse(response);
      }
      return;
    });

    return () => {
      subscription.remove();
    };
  }, [openNotification]);
}
