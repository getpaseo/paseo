const NOTIFICATION_ROUTE_KEY = "__paseoNotificationRoute";

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const notificationRoute = event.notification.data?.[NOTIFICATION_ROUTE_KEY];
  const route =
    typeof notificationRoute === "string" && notificationRoute.startsWith("/")
      ? notificationRoute
      : "/";
  const candidateUrl = new URL(route, self.location.origin);
  const targetUrl =
    candidateUrl.origin === self.location.origin
      ? candidateUrl.href
      : new URL("/", self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existingWindow =
        windows.find((client) => client.focused) ??
        windows.find((client) => client.visibilityState === "visible") ??
        windows[0];
      if (existingWindow) {
        if (typeof existingWindow.navigate === "function") {
          await existingWindow.navigate(targetUrl);
        }
        await existingWindow.focus();
        return;
      }

      await self.clients.openWindow(targetUrl);
    })(),
  );
});
