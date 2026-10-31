import { useNetworkRoutingStatus } from "@/desktop/browser/network-routing/status";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import React, { useCallback, useEffect, useReducer, useRef } from "react";
import { DesktopEventUnavailableError } from "@/desktop/electron/events";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { getIsElectron } from "@/constants/platform";
import { useIsLocalDaemon, useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import {
  getBrowserRoutingState,
  getRoutingOptionAvailability,
  ipcAckSchema,
  requireIpcSuccess,
  routingChangedSchema,
  routingDesktop,
  supportsNetworkTunnel,
  type RoutingDesktop,
} from "@/desktop/browser/network-routing/contract";

type RoutingSubscriptionState = { attempt: number } & (
  | { status: "pending" }
  | { status: "ready" }
  | { status: "failed"; error: unknown }
);

type RoutingSubscriptionAction =
  | { type: "ready" }
  | { type: "failed"; error: unknown }
  | { type: "retry" };

function routingSubscriptionReducer(
  state: RoutingSubscriptionState,
  action: RoutingSubscriptionAction,
): RoutingSubscriptionState {
  switch (action.type) {
    case "ready":
      return { status: "ready", attempt: state.attempt };
    case "failed":
      return { status: "failed", attempt: state.attempt, error: action.error };
    case "retry":
      return { status: "pending", attempt: state.attempt + 1 };
  }
}

export function BrowserRoutingCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isLocal = useIsLocalDaemon(serverId);
  const localState = useLocalDaemonServerIdState();
  const features = useSessionStore((state) => state.sessions[serverId]?.serverInfo?.features);
  const availability = getRoutingOptionAvailability({
    isElectron: getIsElectron(),
    isLocal,
    supported: supportsNetworkTunnel(features),
  });
  if (!availability.visible || localState.status !== "resolved") return null;
  return (
    <SettingsSection title={t("browserRouting.sectionTitle")}>
      <BrowserRoutingSetting
        key={serverId}
        serverId={serverId}
        available={availability.available}
        desktop={routingDesktop}
      />
    </SettingsSection>
  );
}
/**
 * The per-host switch. `desktop` is the port to the desktop main process, where the choice
 * is persisted; the card passes the Electron bridge and tests pass an in-memory adapter.
 */
export function BrowserRoutingSetting({
  serverId,
  available,
  desktop,
}: {
  serverId: string;
  available: boolean;
  desktop: RoutingDesktop;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [subscription, dispatchSubscription] = useReducer(routingSubscriptionReducer, {
    status: "pending",
    attempt: 0,
  });
  const routingEventVersion = useRef(0);
  const permissionDenied = useNetworkRoutingStatus(
    (state) => state.hosts[serverId]?.status === "permission_denied",
  );
  const queryKey = ["browser-routing", serverId];
  const state = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey,
    queryFn: () => getBrowserRoutingState(serverId, desktop),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const eventVersion = routingEventVersion.current;
      requireIpcSuccess(
        ipcAckSchema.parse(
          await desktop.invoke("browser_routing_set_enabled", { serverId, enabled }),
        ),
      );
      return { enabled, eventVersion };
    },
    onSuccess: ({ enabled, eventVersion }) => {
      // Another window's newer choice can arrive before this save acknowledgement.
      if (eventVersion === routingEventVersion.current)
        queryClient.setQueryData(["browser-routing", serverId], enabled);
    },
  });
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void desktop
      .listen("browser_routing_changed", (raw) => {
        const event = routingChangedSchema.parse(raw);
        if (event.serverId === serverId) {
          routingEventVersion.current += 1;
          void queryClient.cancelQueries({ queryKey: ["browser-routing", serverId], exact: true });
          queryClient.setQueryData(["browser-routing", serverId], event.enabled);
        }
      })
      .then(
        (dispose) => {
          if (disposed) dispose();
          else {
            unlisten = dispose;
            dispatchSubscription({ type: "ready" });
          }
          return;
        },
        (error: unknown) => {
          if (!disposed) dispatchSubscription({ type: "failed", error });
        },
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, queryClient, serverId, subscription.attempt]);
  const failed = state.isError || mutation.isError || subscription.status === "failed";
  const handleValueChange = useCallback((next: boolean) => mutation.mutate(next), [mutation]);
  const handleRetry = useCallback(() => {
    if (subscription.status === "failed") dispatchSubscription({ type: "retry" });
    void state.refetch();
  }, [state, subscription.status]);
  if (
    subscription.status === "failed" &&
    !(subscription.error instanceof DesktopEventUnavailableError)
  ) {
    throw subscription.error;
  }
  return (
    <View style={settingsStyles.card} testID="host-page-browser-routing-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("browserRouting.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("browserRouting.description")}</Text>
          {!available ? (
            <Text style={settingsStyles.rowHint}>{t("browserRouting.updateHost")}</Text>
          ) : null}
          {state.isPending || mutation.isPending || subscription.status === "pending" ? (
            <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text>
          ) : null}
          {state.isError || subscription.status === "failed" ? (
            <Button variant="ghost" size="sm" onPress={handleRetry}>
              {t("common.actions.retry")}
            </Button>
          ) : null}
          {permissionDenied ? (
            <Text
              style={settingsStyles.rowError}
              testID="host-page-browser-routing-permission-error"
            >
              {t("browserRouting.permissionDenied")}
            </Text>
          ) : null}
          {failed ? (
            <Text style={settingsStyles.rowError} testID="host-page-browser-routing-error">
              {t("browserRouting.settingFailed")}
            </Text>
          ) : null}
        </View>
        <Switch
          value={state.data === true}
          disabled={
            (!available && state.data !== true) ||
            !state.isSuccess ||
            mutation.isPending ||
            subscription.status !== "ready"
          }
          onValueChange={handleValueChange}
          accessibilityLabel={t("browserRouting.title")}
          testID="host-page-browser-routing-switch"
        />
      </View>
    </View>
  );
}
