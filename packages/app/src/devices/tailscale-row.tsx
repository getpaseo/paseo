import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SettingsAction, SettingsRowChildren, SettingsSwitch } from "@/components/settings";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { describeTailscale } from "./tailscale-hint";

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

  return (
    <>
      <SettingsSwitch
        label={LABEL}
        hint={status ? describeTailscale(status, t) : t("devices.tailscale.hint")}
        link={status?.state === "unavailable" ? installLink : undefined}
        error={tailscale.error}
        value={tailscale.value}
        disabled={!status || status.state === "unavailable" || Boolean(status.lockedBy)}
        onValueChange={tailscale.setEnabled}
      />
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

  const query = useFetchQuery({
    queryKey,
    queryFn: async () => {
      const { tailscale } = await client.getDaemonStatus({ includeProviders: false });
      if (!tailscale) throw new Error("Host did not report Tailscale status");
      return tailscale;
    },
    // Tailscale can come up after the host does; polling moves "waiting" to "on" on its own.
    refetchInterval: 2_000,
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

  const status = query.data;
  const pending = change.isPending ? change.variables.enabled : undefined;
  const on = status?.state === "on" || status?.state === "waiting";
  // Not known until the host first answers.
  const value = pending ?? (status ? on : null);

  const { mutate } = change;
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
    if (await confirmTurnOff()) mutate({ enabled: false, confirmed: true });
  }, [confirmTurnOff, mutate]);
  const disconnects = status?.disconnectsCurrentConnection === true;
  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!enabled && disconnects) {
        void turnOffConfirmed();
        return;
      }
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
    [disconnects, mutate, turnOffConfirmed],
  );

  let error: string | undefined;
  if (change.isError) {
    error = t(
      change.variables.enabled ? "devices.tailscale.turnOnError" : "devices.tailscale.turnOffError",
    );
  } else if (query.isError && !status) {
    error = t("devices.tailscale.statusError");
  }

  return {
    status,
    value,
    error,
    // A tap is ignored until the host answers the one before it.
    setEnabled: change.isPending ? undefined : setEnabled,
    address: status?.state === "on" && value ? status.address : null,
  };
}
