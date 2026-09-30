import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { JiraSiteSetting } from "@/leitstand/jira-site-setting";

/**
 * Accounts this host acts as toward planning and code hosting. GitHub lists the
 * gh logins the daemon found; which one a project uses stays in project settings.
 */
export function HostLinkedAccountsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  const accounts = useFetchQuery({
    queryKey: ["forge-accounts", serverId],
    queryFn: () => client!.listForgeAccounts(),
    enabled: isConnected && client !== null,
    dataShape: "list",
    staleTimeMs: 0,
  });

  let body: ReactNode;
  if (!isConnected) {
    body = <StatusRow text={t("settings.linkedAccounts.github.offline")} />;
  } else if (accounts.isPending) {
    body = <StatusRow text={t("settings.linkedAccounts.github.loading")} />;
  } else if (accounts.error) {
    body = <StatusRow text={accounts.error.message} isError />;
  } else if (accounts.data.length === 0) {
    body = <StatusRow text={t("workspace.forgeAccount.empty")} />;
  } else {
    body = accounts.data.map((account) => (
      <SettingsRow
        key={account.configDir}
        label={account.username}
        hint={`${account.host} · ${account.configDir}`}
        testID={`linked-accounts-github-${account.username}`}
      />
    ));
  }

  return (
    <View>
      <SettingsSection
        title={t("settings.linkedAccounts.github.title")}
        info={t("settings.linkedAccounts.github.info")}
        testID="linked-accounts-github"
      >
        <SettingsCard>{body}</SettingsCard>
      </SettingsSection>
      <SettingsSection
        title={t("settings.linkedAccounts.jira.title")}
        info={t("settings.linkedAccounts.jira.info")}
        testID="linked-accounts-jira"
      >
        <SettingsCard>
          <View style={settingsStyles.row}>
            <JiraSiteSetting />
          </View>
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

function StatusRow({ text, isError = false }: { text: string; isError?: boolean }) {
  return (
    <View style={settingsStyles.row}>
      <Text style={isError ? settingsStyles.rowError : settingsStyles.rowHint}>{text}</Text>
    </View>
  );
}
