import { useNetworkRoutingStatus } from "@/desktop/browser/network-routing/status";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import React, { useCallback, useEffect } from "react";
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
      requireIpcSuccess(
        ipcAckSchema.parse(
          await desktop.invoke("browser_routing_set_enabled", { serverId, enabled }),
        ),
      );
      return enabled;
    },
    onSuccess: (enabled) => queryClient.setQueryData(["browser-routing", serverId], enabled),
  });
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void desktop
      .listen("browser_routing_changed", (raw) => {
        const event = routingChangedSchema.parse(raw);
        if (event.serverId === serverId)
          queryClient.setQueryData(["browser-routing", serverId], event.enabled);
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
        return;
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: ["browser-routing", serverId] });
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, queryClient, serverId]);
  const failed = state.isError || mutation.isError;
  const handleValueChange = useCallback((next: boolean) => mutation.mutate(next), [mutation]);
  const handleRetry = useCallback(() => {
    void state.refetch();
  }, [state]);
  return (
    <View style={settingsStyles.card} testID="host-page-browser-routing-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("browserRouting.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("browserRouting.description")}</Text>
          {!available ? (
            <Text style={settingsStyles.rowHint}>{t("browserRouting.updateHost")}</Text>
          ) : null}
          {state.isPending || mutation.isPending ? (
            <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text>
          ) : null}
          {state.isError ? (
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
          disabled={(!available && state.data !== true) || !state.isSuccess || mutation.isPending}
          onValueChange={handleValueChange}
          accessibilityLabel={t("browserRouting.title")}
          testID="host-page-browser-routing-switch"
        />
      </View>
    </View>
  );
}
