import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost, type DesktopSavedLogin } from "@/desktop/host";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

const SAVED_PASSWORDS_QUERY_KEY = ["browser-saved-passwords"] as const;

function getPasswordBridge() {
  const bridge = getDesktopHost()?.browser;
  if (!bridge?.listSavedPasswords || !bridge.removeSavedPassword) {
    throw new Error("Electron browser password bridge is unavailable");
  }
  return { list: bridge.listSavedPasswords, remove: bridge.removeSavedPassword };
}

export function SavedPasswordsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const hostProfile = useHostFeature(serverId, "browserScreencast");
  const hostPasswords = useHostFeature(serverId, "browserProfileImport");
  const read = async () => {
    if (!hostProfile) return getPasswordBridge().list();
    if (!client || !hostPasswords)
      throw new Error("Update and connect the host to manage its saved passwords.");
    const result = await client.manageBrowserPasswords({ action: "list" });
    if (result.error) throw new Error(result.error);
    return result;
  };
  const remove = useCallback(
    async (login: DesktopSavedLogin) => {
      if (!hostProfile) return getPasswordBridge().remove(login);
      if (!client || !hostPasswords)
        throw new Error("Update and connect the host to manage its saved passwords.");
      const result = await client.manageBrowserPasswords({
        action: "remove",
        origin: login.origin,
        username: login.username,
      });
      if (result.error) throw new Error(result.error);
    },
    [client, hostProfile, hostPasswords],
  );
  const saved = useFetchQuery({
    queryKey: [...SAVED_PASSWORDS_QUERY_KEY, serverId, hostProfile],
    queryFn: read,
    dataShape: "value",
    staleTimeMs: 0,
  });

  return (
    <SettingsSection
      title={t("settings.browser.passwords.title")}
      info={t("settings.browser.passwords.info")}
    >
      <SettingsCard>
        <SavedPasswordsCardBody
          isLoading={saved.isPending}
          available={saved.data?.available ?? true}
          logins={saved.data?.logins ?? []}
          loadError={saved.error}
          remove={remove}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function SavedPasswordsCardBody({
  isLoading,
  available,
  logins,
  loadError,
  remove,
}: {
  isLoading: boolean;
  available: boolean;
  logins: DesktopSavedLogin[];
  loadError: Error | null;
  remove: (login: DesktopSavedLogin) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowHint}>{t("settings.browser.passwords.loading")}</Text>
      </View>
    );
  }
  if (logins.length === 0) {
    return (
      <SettingsRow
        label={t("settings.browser.passwords.empty")}
        hint={available ? undefined : t("settings.browser.passwords.unavailable")}
        error={loadError?.message}
      />
    );
  }
  return logins.map((login) => (
    <SavedPasswordRow key={`${login.origin}\n${login.username}`} login={login} remove={remove} />
  ));
}

function SavedPasswordRow({
  login,
  remove,
}: {
  login: DesktopSavedLogin;
  remove: (login: DesktopSavedLogin) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const username = login.username || t("settings.browser.passwords.noUsername");
  const removal = useMutation({
    mutationFn: async () => {
      const confirmed = await confirmDialog({
        title: t("settings.browser.passwords.confirmTitle"),
        message: t("settings.browser.passwords.confirmMessage", {
          username,
          origin: login.origin,
        }),
        confirmLabel: t("settings.browser.passwords.delete"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await remove(login);
      await queryClient.invalidateQueries({ queryKey: SAVED_PASSWORDS_QUERY_KEY });
    },
  });
  const handlePress = useCallback(() => removal.mutate(), [removal]);

  return (
    <SettingsRow
      label={login.origin}
      hint={username}
      error={removal.error ? t("settings.browser.passwords.deleteFailed") : undefined}
    >
      <Button
        variant="outline"
        size="sm"
        loading={removal.isPending}
        disabled={removal.isPending}
        onPress={handlePress}
      >
        {removal.isPending
          ? t("settings.browser.passwords.deleting")
          : t("settings.browser.passwords.delete")}
      </Button>
    </SettingsRow>
  );
}
