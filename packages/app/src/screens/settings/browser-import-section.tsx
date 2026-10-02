import { Text, View } from "react-native";
import { useCallback, useRef, useState } from "react";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { BrowserImportSource } from "@getpaseo/protocol/browser-import/rpc-schemas";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { getIsElectron } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost } from "@/desktop/host";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type ImportLocation = "host" | "device";

interface ImportSourceEntry {
  location: ImportLocation;
  source: BrowserImportSource;
}

export function BrowserImportSection({
  serverId,
  isLocalDaemon,
}: {
  serverId: string;
  isLocalDaemon: boolean;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  const isSupported = useHostFeature(serverId, "browserCookieImport");
  const useHostProfile = useHostFeature(serverId, "browserScreencast");
  const fullHostImport = useHostFeature(serverId, "browserProfileImport");
  const bridge = getDesktopHost()?.browser;

  const listDeviceSources = getIsElectron() ? bridge?.listImportSources : undefined;

  const hostSources = useFetchQuery({
    queryKey: ["browser-import-sources", "host", serverId],
    queryFn: async () => {
      const response = await client!.listBrowserImportSources();
      if (response.error) throw new Error(response.error);
      return response.sources;
    },
    enabled: isConnected && isSupported && client !== null,
    dataShape: "list",
    staleTimeMs: 0,
  });
  const deviceSources = useFetchQuery({
    queryKey: ["browser-import-sources", "device"],
    queryFn: () => listDeviceSources!(),
    enabled: listDeviceSources !== undefined,
    dataShape: "list",
    staleTimeMs: 0,
  });

  if (!isConnected) return null;

  const entries: ImportSourceEntry[] = [
    ...(deviceSources.data ?? []).map((source) => ({ location: "device" as const, source })),
    ...(hostSources.data ?? []).map((source) => ({ location: "host" as const, source })),
  ];
  const isLoading =
    (isSupported && hostSources.isPending) ||
    (listDeviceSources !== undefined && deviceSources.isPending);
  const loadError = hostSources.error ?? deviceSources.error;

  return (
    <SettingsSection
      title={t("settings.browser.import.title")}
      info={t("settings.browser.import.info")}
    >
      <SettingsCard>
        <BrowserImportCardBody
          isSupported={isSupported || listDeviceSources !== undefined}
          isLoading={isLoading}
          entries={entries}
          loadError={loadError}
          client={client}
          isLocalDaemon={isLocalDaemon}
          canCopyToHost={isSupported}
          useHostProfile={useHostProfile}
          fullHostImport={fullHostImport}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function BrowserImportCardBody({
  isSupported,
  isLoading,
  entries,
  loadError,
  client,
  isLocalDaemon,
  canCopyToHost,
  useHostProfile,
  fullHostImport,
}: {
  isSupported: boolean;
  isLoading: boolean;
  entries: ImportSourceEntry[];
  loadError: Error | null;
  client: DaemonClient | null;
  isLocalDaemon: boolean;
  canCopyToHost: boolean;
  useHostProfile: boolean;
  fullHostImport: boolean;
}) {
  const { t } = useTranslation();
  if (!isSupported) {
    return (
      <SettingsRow
        label={t("settings.browser.import.unsupported.label")}
        hint={t("settings.browser.import.unsupported.hint")}
      />
    );
  }
  if (isLoading) {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowHint}>{t("settings.browser.import.loading")}</Text>
      </View>
    );
  }
  if (entries.length === 0) {
    return <SettingsRow label={t("settings.browser.import.empty")} error={loadError?.message} />;
  }
  return entries.map((entry) => (
    <BrowserImportRow
      key={`${entry.location}:${entry.source.id}`}
      entry={entry}
      client={client}
      isHostThisDevice={isLocalDaemon}
      canCopyToHost={canCopyToHost}
      useHostProfile={useHostProfile}
      fullHostImport={fullHostImport}
    />
  ));
}

function BrowserImportRow({
  entry,
  client,
  isHostThisDevice,
  canCopyToHost,
  useHostProfile,
  fullHostImport,
}: {
  entry: ImportSourceEntry;
  client: DaemonClient | null;
  isHostThisDevice: boolean;
  canCopyToHost: boolean;
  useHostProfile: boolean;
  fullHostImport: boolean;
}) {
  const { t } = useTranslation();
  const [primaryPassword, setPrimaryPassword] = useState("");
  const primaryPasswordInput = useRef<EditingTextInputHandle>(null);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      if (entry.location === "device") {
        if (useHostProfile) {
          if (!fullHostImport)
            throw new Error(
              "Update the host to import cookies and passwords into the displayed browser.",
            );
          const read = getDesktopHost()?.browser?.readImportProfile;
          if (!read) throw new Error("Update the desktop app to import browser passwords.");
          const local = await read({ sourceId: entry.source.id, primaryPassword });
          if (!local.ok) throw new Error(local.error);
          const response = await client.importBrowserCookies({
            kind: "cookies",
            cookies: local.cookies,
            logins: local.logins,
          });
          if (response.error) throw new Error(response.error);
          return {
            ...response,
            passwordCount: response.passwordCount ?? 0,
            skippedPasswords: response.skippedPasswords ?? 0,
          };
        }
        const importProfile = getDesktopHost()?.browser?.importProfile;
        if (!importProfile) throw new Error("Update the desktop app to import browser passwords.");
        const result = await importProfile({ sourceId: entry.source.id, primaryPassword });
        if (!result.ok) throw new Error(result.error);
        return result;
      }
      const response = await client.importBrowserCookies({
        kind: "host",
        sourceId: entry.source.id,
        ...(fullHostImport ? { includePasswords: true, primaryPassword } : {}),
      });
      if (response.error) throw new Error(response.error);
      return {
        ...response,
        passwordCount: response.passwordCount ?? 0,
        skippedPasswords: response.skippedPasswords ?? 0,
      };
    },
    onSettled: () => {
      setPrimaryPassword("");
      primaryPasswordInput.current?.replaceText("");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["browser-saved-passwords"] }),
  });
  const copyToHost = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const read = getDesktopHost()?.browser?.readImportCookies;
      if (!read) throw new Error("Update the desktop app to copy cookies to the host browser.");
      const local = await read(entry.source.id);
      if (!local.ok) throw new Error(local.error);
      const response = await client.importBrowserCookies({
        kind: "cookies",
        cookies: local.cookies,
      });
      if (response.error) throw new Error(response.error);
      return response;
    },
  });
  const handleCopy = useCallback(() => copyToHost.mutate(), [copyToHost]);

  const handlePress = useCallback(() => mutation.mutate(), [mutation]);
  const location =
    entry.location === "device" || isHostThisDevice
      ? t("settings.browser.import.onThisDevice")
      : t("settings.browser.import.onHost");
  const targetLabel =
    entry.location === "device" && !useHostProfile ? "Desktop browser" : "Host browser / handoff";
  const hint = mutation.data
    ? t("settings.browser.import.success", {
        cookieCount: mutation.data.cookieCount,
        domainCount: mutation.data.domainCount,
      }) +
      `; ${mutation.data.passwordCount} passwords (${mutation.data.skippedPasswords} existing passwords preserved) → ${targetLabel}`
    : `${location} → ${targetLabel} (${entry.location === "device" || fullHostImport ? "cookies + passwords" : "cookies; update host for passwords"})`;

  return (
    <SettingsRow
      label={`${entry.source.browserName} – ${entry.source.profileName}`}
      hint={hint}
      error={mutation.error?.message ?? copyToHost.error?.message}
      testID={`browser-import-row-${entry.location}-${entry.source.id}`}
    >
      {entry.source.browserName === "Firefox" && (entry.location === "device" || fullHostImport) ? (
        <AdaptiveTextInput
          accessibilityLabel="Firefox Primary Password (optional)"
          placeholder="Primary Password (optional)"
          secureTextEntry
          ref={primaryPasswordInput}
          onChangeText={setPrimaryPassword}
          autoComplete="off"
        />
      ) : null}
      <Button
        variant="outline"
        size="sm"
        loading={mutation.isPending}
        disabled={mutation.isPending}
        onPress={handlePress}
      >
        {mutation.isPending
          ? t("settings.browser.import.importing")
          : t("settings.browser.import.action")}
      </Button>
      {entry.location === "device" && canCopyToHost && !fullHostImport ? (
        <Button
          variant="outline"
          size="sm"
          loading={copyToHost.isPending}
          disabled={mutation.isPending || copyToHost.isPending}
          onPress={handleCopy}
        >
          {copyToHost.data
            ? `${copyToHost.data.cookieCount} cookies copied to host`
            : "Copy cookies to host / handoff"}
        </Button>
      ) : null}
    </SettingsRow>
  );
}
