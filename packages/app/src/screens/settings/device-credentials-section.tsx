import { useCallback } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

export function DeviceCredentialsSection({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = client?.getLastServerInfoMessage()?.features?.deviceCredentials === true;
  const allowed = client?.getLastServerInfoMessage()?.permissions?.includes("access.manage");
  const devices = useFetchQuery({
    queryKey: ["device-credentials", serverId],
    queryFn: () => {
      if (!client) throw new Error("Host disconnected");
      return client.listDeviceCredentials();
    },
    enabled: connected && supported && allowed,
    dataShape: "list",
    staleTimeMs: 0,
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      if (!client) throw new Error("Host disconnected");
      const confirmed = await confirmDialog({
        title: "Revoke device?",
        message: "This device will need to pair again to connect to this host.",
        confirmLabel: "Revoke",
        destructive: true,
      });
      if (!confirmed) return;
      await client.revokeDeviceCredential(id);
      await devices.refetch();
    },
  });
  const refetch = devices.refetch;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (!supported || !allowed) return null;
  return (
    <SettingsSection title="Devices">
      {!connected ? <Alert variant="warning" description="Host disconnected" /> : null}
      {devices.isPending ? <Text style={settingsStyles.rowHint}>Loading devices…</Text> : null}
      {devices.error ? (
        <Alert variant="error" description={devices.error.message}>
          <Button variant="outline" onPress={retry}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {revoke.error ? <Alert variant="error" description={revoke.error.message} /> : null}
      {devices.data?.length === 0 ? (
        <Text style={settingsStyles.rowHint}>No paired devices</Text>
      ) : null}
      <View style={settingsStyles.card}>
        {devices.data?.map((device) => (
          <DeviceCredentialRow
            key={device.id}
            device={device}
            disabled={!connected || revoke.isPending}
            pending={revoke.isPending && revoke.variables === device.id}
            onRevoke={revoke.mutate}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

interface DeviceCredentialRowProps {
  device: Awaited<ReturnType<DaemonClient["listDeviceCredentials"]>>[number];
  disabled: boolean;
  pending: boolean;
  onRevoke: (id: string) => void;
}
function DeviceCredentialRow({ device, disabled, pending, onRevoke }: DeviceCredentialRowProps) {
  const revoke = useCallback(() => onRevoke(device.id), [device.id, onRevoke]);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {device.label}
          {device.current ? " (this device)" : ""}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {new Date(device.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <Button variant="outline" disabled={disabled} loading={pending} onPress={revoke}>
        Revoke
      </Button>
    </View>
  );
}
