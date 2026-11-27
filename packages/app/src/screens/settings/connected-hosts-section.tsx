import { createPaseoApi, type HostDirectory, type HostSummary } from "@getpaseo/client";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsAddRow, SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  approveReverseHost,
  parseDaemonConnection,
  revokeReverseHost,
  type ReverseAccess,
} from "@/hosts/connected-host-actions";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

type HostClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;
type Dialog = { kind: "add" } | { kind: "approve" | "revoke" | "remove"; host: HostSummary };

function errorMessage(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
}

function useConnectedHostDirectory(client: HostClient) {
  const [directory, setDirectory] = useState<HostDirectory>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const observation = client.observeHosts();
    let active = true;
    const apply = (next: HostDirectory) => {
      if (active) {
        setDirectory(next);
        setError(undefined);
      }
    };
    const unsubscribe = observation.subscribe({
      snapshot: apply,
      update: (message) => {
        if (message.type === "hosts.changed") apply(message.payload.directory);
      },
    });
    void observation.ready.then(apply).catch((failure) => {
      if (active) setError(failure);
    });
    return () => {
      active = false;
      unsubscribe();
      void observation.release().catch(() => undefined);
    };
  }, [client]);
  return { directory, error };
}

export function ConnectedHostsSection({ serverId, label }: { serverId: string; label: string }) {
  const supportsConnectedHosts = useHostFeature(serverId, "connectedHosts");
  const supportsReverse = useHostFeature(serverId, "hostBidirectionalLinks");
  const connected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  if (!supportsConnectedHosts || !client || !connected) return null;
  return (
    <ConnectedHostsCard
      key={serverId}
      client={client}
      label={label}
      supportsReverse={supportsReverse}
    />
  );
}

function ConnectedHostsCard({
  client,
  label,
  supportsReverse,
}: {
  client: HostClient;
  label: string;
  supportsReverse: boolean;
}) {
  const { t } = useTranslation();
  const { directory, error } = useConnectedHostDirectory(client);
  const [dialog, setDialog] = useState<Dialog>();
  const permissions = client.getLastServerInfoMessage()?.permissions ?? [];
  const canManage = permissions.includes("tunnel.manage");
  const canManageReverse = supportsReverse && canManage && permissions.includes("access.manage");
  const addHost = useCallback(() => setDialog({ kind: "add" }), []);
  const closeDialog = useCallback(() => setDialog(undefined), []);

  return (
    <SettingsSection
      title={t("settings.connectedHosts.title")}
      info={t("settings.connectedHosts.managedBy", { host: label })}
      testID="daemon-connected-hosts"
    >
      <SettingsCard>
        {error ? (
          <SettingsRow label={t("settings.connectedHosts.loadError")} error={errorMessage(error)} />
        ) : null}
        {!error && !directory ? <SettingsRow label={t("settings.connectedHosts.loading")} /> : null}
        {!error &&
          directory?.hosts.map((host) => (
            <ConnectedHostRow
              key={host.registrationId}
              host={host}
              canManage={canManage}
              canManageReverse={canManageReverse}
              onAction={setDialog}
            />
          ))}
        {directory && canManage ? (
          <SettingsAddRow
            label={t("settings.connectedHosts.add")}
            onPress={addHost}
            testID="daemon-connected-host-add"
          />
        ) : null}
        {directory && directory.hosts.length === 0 && !canManage ? (
          <SettingsRow label={t("settings.connectedHosts.empty")} />
        ) : null}
      </SettingsCard>
      {dialog ? (
        <ConnectedHostSheet client={client} label={label} dialog={dialog} onClose={closeDialog} />
      ) : null}
    </SettingsSection>
  );
}

function ConnectedHostRow({
  host,
  canManage,
  canManageReverse,
  onAction,
}: {
  host: HostSummary;
  canManage: boolean;
  canManageReverse: boolean;
  onAction: (dialog: Dialog) => void;
}) {
  const { t } = useTranslation();
  const incoming = host.direction === "incoming";
  const canRevoke = canManageReverse && host.reverseEnabled;
  const canApprove =
    canManageReverse &&
    !incoming &&
    !host.reverseEnabled &&
    host.serverId &&
    host.status === "online";
  const approve = useCallback(() => onAction({ kind: "approve", host }), [host, onAction]);
  const revoke = useCallback(() => onAction({ kind: "revoke", host }), [host, onAction]);
  const remove = useCallback(() => onAction({ kind: "remove", host }), [host, onAction]);
  const badge = useMemo(() => {
    const variants = { online: "success", error: "error" } as const;
    const variant =
      host.status === "online" || host.status === "error" ? variants[host.status] : "muted";
    return (
      <StatusBadge
        size="xs"
        label={t(`settings.connectedHosts.status.${host.status}`)}
        variant={variant}
      />
    );
  }, [host.status, t]);
  const reverseStatus = host.reverseEnabled
    ? t("settings.connectedHosts.reverseStatus", {
        status: t(`settings.connectedHosts.status.${host.reverseStatus ?? "offline"}`),
      })
    : undefined;
  const hints = [
    incoming ? t("settings.connectedHosts.incoming") : host.targetDescription,
    reverseStatus,
  ];
  return (
    <SettingsRow
      label={host.label ?? host.targetDescription}
      labelAccessory={badge}
      hint={hints.filter(Boolean).join(" · ")}
      error={
        host.error?.message ??
        (host.reverseStatus === "error"
          ? t("settings.connectedHosts.reverseError", {
              peer: host.label ?? host.targetDescription,
            })
          : undefined)
      }
      testID={`daemon-connected-host-${host.registrationId}`}
    >
      {canRevoke ? (
        <Button variant="ghost" onPress={revoke}>
          {t("settings.connectedHosts.disableReverse")}
        </Button>
      ) : null}
      {canApprove ? (
        <Button variant="ghost" onPress={approve} testID="daemon-connected-host-enable-reverse">
          {t("settings.connectedHosts.enableReverse")}
        </Button>
      ) : null}
      {canManage ? (
        <Button variant="ghost" onPress={remove}>
          {t("settings.connectedHosts.remove")}
        </Button>
      ) : null}
    </SettingsRow>
  );
}

function ConnectedHostSheet({
  client,
  label,
  dialog,
  onClose,
}: {
  client: HostClient;
  label: string;
  dialog: Dialog;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ReverseAccess>("read");
  const title = t(`settings.connectedHosts.action.${dialog.kind}`);
  const mutation = useMutation({
    mutationFn: async () => {
      if (dialog.kind === "add") {
        await client.addHost({
          connection: parseDaemonConnection(address, password),
          label: name.trim() || undefined,
        });
        return;
      }
      if (dialog.kind === "remove") {
        await client.removeHost(dialog.host.registrationId);
        return;
      }
      const api = createPaseoApi(client);
      try {
        if (dialog.kind === "revoke") {
          await revokeReverseHost(api.hosts, dialog.host);
        } else {
          const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          await approveReverseHost(api.hosts, dialog.host, label, access, token);
        }
      } finally {
        await api.dispose().catch(() => undefined);
      }
    },
    onSuccess: onClose,
  });
  const { isPending, mutate } = mutation;
  const close = useCallback(() => {
    if (!isPending) onClose();
  }, [isPending, onClose]);
  const confirm = useCallback(() => mutate(), [mutate]);
  const header = useMemo(() => ({ title }), [title]);
  const fieldError = mutation.isError
    ? (errorMessage(mutation.error) ?? t("settings.connectedHosts.changeError"))
    : undefined;
  const peer = dialog.kind === "add" ? "" : (dialog.host.label ?? dialog.host.targetDescription);
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      testID="daemon-connected-host-sheet"
    >
      <View style={styles.form}>
        {dialog.kind === "add" ? (
          <>
            <Field label={t("settings.connectedHosts.address")}>
              <FormTextInput
                size={size}
                initialValue=""
                onChangeText={setAddress}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="ssh://user@host"
                editable={!mutation.isPending}
                testID="daemon-connected-host-address"
              />
            </Field>
            <Field label={t("settings.connectedHosts.password")}>
              <FormTextInput
                size={size}
                initialValue=""
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                editable={!mutation.isPending}
              />
            </Field>
            <Field label={t("settings.connectedHosts.nickname")}>
              <FormTextInput
                size={size}
                initialValue=""
                onChangeText={setName}
                editable={!mutation.isPending}
                testID="daemon-connected-host-name"
              />
            </Field>
            <Text style={settingsStyles.rowHint}>
              {t("settings.connectedHosts.connectFrom", { host: label })}
            </Text>
          </>
        ) : null}
        {dialog.kind === "approve" ? (
          <>
            <Text style={settingsStyles.rowHint}>
              {t(
                access === "write"
                  ? "settings.connectedHosts.approveWriteHint"
                  : "settings.connectedHosts.approveHint",
                { host: label, peer },
              )}
            </Text>
            <SegmentedControl
              size={size}
              value={access}
              onValueChange={setAccess}
              options={[
                {
                  value: "read",
                  label: t("settings.connectedHosts.read"),
                  disabled: mutation.isPending,
                },
                {
                  value: "write",
                  label: t("settings.connectedHosts.write"),
                  disabled: mutation.isPending,
                },
              ]}
            />
          </>
        ) : null}
        {dialog.kind === "remove" || dialog.kind === "revoke" ? (
          <Text style={settingsStyles.rowHint}>
            {t(`settings.connectedHosts.${dialog.kind}Hint`, { peer })}
          </Text>
        ) : null}
        {fieldError ? (
          <Text
            style={settingsStyles.rowHint}
            accessibilityRole="alert"
            testID="daemon-connected-host-error"
          >
            {fieldError}
          </Text>
        ) : null}
        <Button
          disabled={mutation.isPending || (dialog.kind === "add" && !address.trim())}
          onPress={confirm}
          testID="daemon-connected-host-confirm"
        >
          {mutation.isPending ? t("settings.connectedHosts.saving") : title}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[3] },
}));
