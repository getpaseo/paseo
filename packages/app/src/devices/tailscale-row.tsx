import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  SettingsAction,
  SettingsRow,
  SettingsRowChildren,
  SettingsSwitch,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { describeTailscale } from "./tailscale-hint";
import { resolveTailscaleControlState } from "./tailscale-state";

const UPDATES_DOCS_URL = "https://paseo.sh/docs/updates";
const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
// A product name, the same in every language.
const LABEL = "Tailscale";

type HostClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

/**
 * Turns Tailscale on or off for a host and shows the address a phone on the tailnet adds. Renders
 * as a row inside a `SettingsCard`; when Tailscale is on, the address is a nested row under it.
 */
export function TailscaleRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connection = useHostRuntimeSnapshot(serverId)?.connectionStatus;
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const updateLink = useMemo(
    () => ({ href: UPDATES_DOCS_URL, label: t("devices.tailscale.updateDocs") }),
    [t],
  );
  // COMPAT(tailscale): added in v0.16.0, remove after 2027-05-25 once daemon floor >= v0.16.0.
  if (serverInfo && serverInfo.features?.tailscale !== true) {
    return (
      <SettingsSwitch
        label={LABEL}
        hint={t("devices.tailscale.update")}
        link={updateLink}
        value={false}
        disabled
      />
    );
  }
  if (client && connection === "online" && serverInfo) {
    return <TailscaleControl serverId={serverId} client={client} />;
  }
  // Without the host the row shows no value: the switch's space stays empty. A host the app has
  // reached before keeps its server info, so while the app retries it still reads as disconnected.
  const lost = connection === "offline" || connection === "error" || Boolean(serverInfo);
  return (
    <SettingsSwitch
      label={LABEL}
      hint={t(lost ? "workspace.terminal.hostDisconnected" : "devices.tailscale.hint")}
      value={null}
    />
  );
}

function TailscaleControl({ serverId, client }: { serverId: string; client: HostClient }) {
  const { t } = useTranslation();
  const tailscale = useTailscale(serverId, client);
  const { status } = tailscale;
  const installLink = useMemo(
    () => ({ href: TAILSCALE_DOWNLOAD_URL, label: t("devices.tailscale.install") }),
    [t],
  );
  const refreshLabel = t(
    tailscale.refreshing ? "devices.tailscale.refreshing" : "devices.tailscale.refresh",
  );
  const refreshButton = tailscale.showRefresh ? (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          leftIcon={RotateCw}
          onPress={tailscale.refresh}
          loading={tailscale.refreshing}
          disabled={tailscale.refreshDisabled}
          accessibilityLabel={refreshLabel}
          testID="devices-tailscale-refresh"
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={6}>
        <Text style={styles.tooltipText}>{refreshLabel}</Text>
      </TooltipContent>
    </Tooltip>
  ) : null;
  const switchControl = tailscale.showSwitch ? (
    <Switch
      value={tailscale.value}
      onValueChange={tailscale.setEnabled}
      disabled={tailscale.switchDisabled}
      accessibilityLabel={LABEL}
    />
  ) : null;

  return (
    <>
      <SettingsRow
        label={LABEL}
        hint={status ? describeTailscale(status, t) : t("devices.tailscale.hint")}
        link={tailscale.showInstallLink ? installLink : undefined}
        error={tailscale.error}
      >
        {refreshButton && switchControl ? (
          <View style={styles.controls}>
            {refreshButton}
            {switchControl}
          </View>
        ) : (
          (refreshButton ?? switchControl)
        )}
      </SettingsRow>
      {tailscale.address ? <TailscaleAddress address={tailscale.address} /> : null}
    </>
  );
}

function TailscaleAddress({ address }: { address: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const copy = useCallback(() => {
    void copyToClipboard(address)
      .then(() => toast.copied())
      .catch(() => toast.error(t("common.errors.error")));
  }, [address, t, toast]);
  return (
    <SettingsRowChildren>
      <SettingsAction
        label={address}
        hint={t("devices.tailscale.address")}
        actionLabel={t("common.actions.copy")}
        onPress={copy}
        testID="devices-tailscale-address"
      />
    </SettingsRowChildren>
  );
}

interface TailscaleChange {
  enabled: boolean;
  confirmed: boolean;
}

/**
 * The host's Tailscale state and the one way to change it. While a change is in flight the switch
 * already shows where it is going, so a tap answers at once; the host's answer then settles it.
 * Turning Tailscale off over the connection it would cut asks first, and nothing changes on screen
 * until the user confirms.
 */
function useTailscale(serverId: string, client: HostClient) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["tailscale-status", serverId], [serverId]);
  const fetchStatus = useCallback(async () => {
    const { tailscale } = await client.getDaemonStatus({ includeProviders: false });
    if (!tailscale) throw new Error("Host did not report Tailscale status");
    return tailscale;
  }, [client]);

  const query = useFetchQuery({
    queryKey,
    queryFn: fetchStatus,
    // Tailscale can come up after the host does; polling and returning to the window pick it up.
    refetchInterval: 2_000,
    refetchOnWindowFocus: true,
    staleTimeMs: 0,
    dataShape: "value",
  });

  const change = useMutation({
    mutationFn: async ({ enabled, confirmed }: TailscaleChange) => {
      await queryClient.cancelQueries({ queryKey });
      return client.setTailscaleEnabled(enabled, confirmed);
    },
    onSuccess: (result) => queryClient.setQueryData(queryKey, result.tailscale),
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries({ queryKey });
      return fetchStatus();
    },
    onSuccess: (tailscale) => queryClient.setQueryData(queryKey, tailscale),
  });

  const status = query.data;
  const control = resolveTailscaleControlState({
    status,
    statusUpdatedAt: query.dataUpdatedAt,
    statusError: query.isError,
    changePending: change.isPending,
    changePendingEnabled: change.variables?.enabled,
    changeError: change.isError,
    changeErrorEnabled: change.variables?.enabled,
    refreshPending: refreshMutation.isPending,
    refreshError: refreshMutation.isError,
    refreshSubmittedAt: refreshMutation.submittedAt,
  });

  const { mutate, reset: resetChange } = change;
  const { mutate: runRefresh, reset: resetRefresh } = refreshMutation;
  const confirmTurnOff = useCallback(
    () =>
      confirmDialog({
        title: t("devices.tailscale.confirmTitle"),
        message: t("devices.tailscale.confirmMessage"),
        confirmLabel: t("devices.tailscale.confirmAction"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }),
    [t],
  );
  const turnOffConfirmed = useCallback(async () => {
    if (await confirmTurnOff()) {
      resetRefresh();
      mutate({ enabled: false, confirmed: true });
    }
  }, [confirmTurnOff, mutate, resetRefresh]);
  const disconnects = status?.disconnectsCurrentConnection === true;
  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!enabled && disconnects) {
        void turnOffConfirmed();
        return;
      }
      resetRefresh();
      mutate(
        { enabled, confirmed: false },
        {
          // The status was stale: the host would cut this connection after all. Its answer has
          // already put the row back to on, so the question is asked over what is true.
          onSuccess: (result) => {
            if (result.confirmationRequired) void turnOffConfirmed();
          },
        },
      );
    },
    [disconnects, mutate, resetRefresh, turnOffConfirmed],
  );
  const refresh = useCallback(() => {
    resetChange();
    runRefresh();
  }, [resetChange, runRefresh]);

  return {
    status,
    value: control.value,
    showSwitch: control.showSwitch,
    switchDisabled: control.switchDisabled,
    showRefresh: control.showRefresh,
    refreshing: control.refreshing,
    refreshDisabled: control.refreshDisabled,
    showInstallLink: control.showInstallLink,
    error: control.errorKey ? t(control.errorKey) : undefined,
    // A tap is ignored until the host answers the one before it.
    setEnabled: control.switchDisabled ? undefined : setEnabled,
    refresh: control.refreshDisabled ? undefined : refresh,
    address: control.address,
  };
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
