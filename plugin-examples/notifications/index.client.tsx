import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AlertScreen } from "./client/alert-screen";

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: "alert",
    title: (params) => (params.buildId ? `Build #${params.buildId}` : "Build alerts"),
    Component: AlertScreen,
  });

  const removeOpenHandler = client.onNotificationOpen(({ event, openScreen, navigation }) => {
    if (event.data?.kind === "agent" && typeof event.data.agentId === "string") {
      navigation.openAgent({ agentId: event.data.agentId, focusHost: true });
      return;
    }
    const buildId = typeof event.data?.buildId === "string" ? event.data.buildId : "latest";
    const summary =
      typeof event.data?.summary === "string"
        ? event.data.summary
        : "Opened from plugin notification";
    openScreen({
      screenId: "alert",
      params: {
        buildId,
        notificationId: event.notificationId,
        summary,
      },
    });
  });

  return () => {
    removeOpenHandler();
    removeScreen();
  };
}
