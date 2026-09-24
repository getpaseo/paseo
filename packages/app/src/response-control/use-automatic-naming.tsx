import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useResponseControlSupported } from "./use-supported";

export function useAutomaticNaming(client: DaemonClient | null, serverId: string) {
  const { t } = useTranslation();
  const supported = useResponseControlSupported(serverId);
  const mutation = useMutation({
    mutationFn: async (agentId: string) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.updateAgent(agentId, { namingMode: "automatic" });
    },
  });
  const apply = useCallback(
    (tab: WorkspaceTabDescriptor) => {
      if (tab.target.kind === "agent" && !mutation.isPending) mutation.mutate(tab.target.agentId);
    },
    [mutation],
  );
  const close = useCallback(() => {
    if (!mutation.isPending) mutation.reset();
  }, [mutation]);
  const retry = useCallback(() => {
    if (mutation.variables) mutation.mutate(mutation.variables);
  }, [mutation]);
  const header = useMemo(() => ({ title: t("responseControl.automaticNaming") }), [t]);
  const notice = (
    <AdaptiveModalSheet
      visible={mutation.isPending || mutation.isError}
      onClose={close}
      header={header}
      testID="automatic-naming-status"
    >
      <View style={settingsStyles.card}>
        <Text style={mutation.isError ? settingsStyles.rowError : settingsStyles.rowHint}>
          {mutation.error?.message ?? t("responseControl.updating")}
        </Text>
        {mutation.isError ? (
          <>
            <Button onPress={retry}>{t("responseControl.retry")}</Button>
            <Button onPress={close}>{t("responseControl.dismiss")}</Button>
          </>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
  return { onUseAutomaticNaming: supported ? apply : undefined, automaticNamingNotice: notice };
}
