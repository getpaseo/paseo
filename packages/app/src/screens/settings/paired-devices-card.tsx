import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { PairedDevice } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

function pairedDevicesQueryKey(serverId: string) {
  return ["paired-devices", serverId] as const;
}

export function PairedDevicesCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const supported = client?.getLastServerInfoMessage()?.features?.pairedDevices === true;
  const query = useFetchQuery({
    queryKey: pairedDevicesQueryKey(serverId),
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.listPairedDevices();
    },
    enabled: supported && Boolean(client),
    dataShape: "value",
    staleTimeMs: 30 * 1000,
  });
  const revoke = useMutation({
    mutationFn: async (deviceId: string) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.revokePairedDevice(deviceId);
    },
    onSettled: () => {
      void query.refetch();
    },
  });

  const lock = useMutation({
    mutationFn: async (locked: boolean) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.setPairedDeviceLock(locked);
    },
    onSettled: () => {
      void query.refetch();
    },
  });
  const toggleLock = useCallback(() => {
    if (query.data) lock.mutate(!query.data.locked);
  }, [lock, query.data]);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  if (!supported) return null;
  if (!query.data) {
    return (
      <View style={settingsStyles.card} testID="paired-devices-card">
        <Text style={settingsStyles.rowTitle}>{t("settings.host.pairDevices.devicesTitle")}</Text>
        {query.error ? (
          <>
            <Text style={settingsStyles.rowError}>{query.error.message}</Text>
            <Button
              variant="outline"
              size="sm"
              onPress={retry}
              loading={query.isFetching}
              testID="paired-devices-retry"
            >
              {t("common.actions.retry")}
            </Button>
          </>
        ) : (
          <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text>
        )}
      </View>
    );
  }
  const { devices, locked } = query.data;
  return (
    <View style={settingsStyles.card} testID="paired-devices-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.pairDevices.devicesTitle")}</Text>
          <Text style={settingsStyles.rowHint}>
            {locked
              ? t("settings.host.pairDevices.locked")
              : t("settings.host.pairDevices.unlocked")}
          </Text>
        </View>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={toggleLock}
        loading={lock.isPending}
        disabled={lock.isPending}
        testID="paired-devices-toggle-lock"
      >
        {locked ? t("settings.host.pairDevices.unlock") : t("settings.host.pairDevices.lock")}
      </Button>
      {lock.error ? <Text style={settingsStyles.rowError}>{lock.error.message}</Text> : null}
      {devices.map((device) => (
        <PairedDeviceRow
          key={device.id}
          device={device}
          pending={revoke.isPending && revoke.variables === device.id}
          onRevoke={revoke.mutate}
        />
      ))}
      {revoke.error ? <Text style={settingsStyles.rowError}>{revoke.error.message}</Text> : null}
    </View>
  );
}

function PairedDeviceRow({
  device,
  pending,
  onRevoke,
}: {
  device: PairedDevice;
  pending: boolean;
  onRevoke: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  const handleRevoke = useCallback(() => onRevoke(device.id), [device.id, onRevoke]);
  const seen = new Date(device.lastSeenAt).toLocaleString();
  return (
    <View
      style={[settingsStyles.row, settingsStyles.rowBorder]}
      testID={`paired-device-${device.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {device.current ? t("settings.host.pairDevices.thisDevice") : device.id}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.host.pairDevices.lastSeen", {
            when: seen,
            version: device.appVersion ?? "?",
          })}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        loading={pending}
        disabled={pending}
        onPress={handleRevoke}
        testID={`paired-device-revoke-${device.id}`}
      >
        {t("settings.host.pairDevices.revoke")}
      </Button>
    </View>
  );
}
