import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { AgentSettingsProfiles } from "@getpaseo/protocol/agent-settings-profile";
import { SettingsCard, SettingsRow, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { generateAgentProfileId } from "../internal/profile-id";

export function AgentSettingsProfileCard({ serverId }: { serverId: string }) {
  const supported = useHostFeature(serverId, "agentSettingsProfiles");
  const { config, patchConfig } = useDaemonConfig(serverId);
  if (!supported || !config) return null;
  return <LoadedAgentSettingsProfileCard config={config} patchConfig={patchConfig} />;
}

function LoadedAgentSettingsProfileCard({
  config,
  patchConfig,
}: {
  config: MutableDaemonConfig;
  patchConfig: ReturnType<typeof useDaemonConfig>["patchConfig"];
}) {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<"create" | "rename" | null>(null);
  const save = useMutation({
    mutationFn: (
      request: Pick<
        MutableDaemonConfigPatch,
        "agentSettingsProfiles" | "expectedAgentSettingsProfiles"
      >,
    ) => patchConfig(request),
  });

  const bundle = useMemo<AgentSettingsProfiles>(
    () =>
      config.agentSettingsProfiles ?? {
        activeProfileId: "default",
        profiles: [
          {
            id: "default",
            name: t("settings.host.agentSettingsProfiles.defaultName"),
            settings: {
              appendSystemPrompt: config.appendSystemPrompt,
              mcp: { injectIntoAgents: config.mcp.injectIntoAgents },
              browserTools: { enabled: config.browserTools.enabled },
              agentProfiles: config.agentProfiles ?? [],
              skills: { selection: config.skills?.selection ?? { mode: "all" } },
            },
          },
        ],
      },
    [config, t],
  );
  const active = bundle.profiles.find((profile) => profile.id === bundle.activeProfileId)!;

  const mutateAsync = save.mutateAsync;
  const saveAsync = useCallback(
    (agentSettingsProfiles: AgentSettingsProfiles) =>
      mutateAsync({
        agentSettingsProfiles,
        expectedAgentSettingsProfiles: config.agentSettingsProfiles ?? null,
      }),
    [config.agentSettingsProfiles, mutateAsync],
  );
  const options = useMemo(
    () => bundle.profiles.map((profile) => ({ label: profile.name, value: profile.id })),
    [bundle],
  );
  const openCreate = useCallback(() => setEditor("create"), []);
  const openRename = useCallback(() => setEditor("rename"), []);
  const closeEditor = useCallback(() => setEditor(null), []);
  const selectProfile = useCallback(
    (activeProfileId: string) => {
      void saveAsync({ ...bundle, activeProfileId }).catch(() => undefined);
    },
    [bundle, saveAsync],
  );

  const saveName = useCallback(
    async (name: string) => {
      if (editor === "create") {
        const id = generateAgentProfileId();
        await saveAsync({
          activeProfileId: id,
          profiles: [...bundle.profiles, { id, name: name.trim(), settings: active.settings }],
        });
      } else {
        await saveAsync({
          ...bundle,
          profiles: bundle.profiles.map((profile) =>
            profile.id === active.id ? { ...profile, name: name.trim() } : profile,
          ),
        });
      }
    },
    [active, bundle, editor, saveAsync],
  );

  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("settings.host.agentProfiles.removeConfirmTitle"),
      message: t("settings.host.agentProfiles.removeConfirmMessage", { name: active.name }),
      confirmLabel: t("settings.host.agentProfiles.remove"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    const profiles = bundle.profiles.filter((profile) => profile.id !== active.id);
    await saveAsync({ profiles, activeProfileId: profiles[0].id });
  }, [active, bundle, saveAsync, t]);
  const handleRemove = useCallback(() => {
    void remove().catch(() => undefined);
  }, [remove]);

  return (
    <>
      <SettingsCard testID="agent-settings-profile-card">
        <SettingsSelect
          label={t("settings.host.agentSettingsProfiles.title")}
          value={active.id}
          options={options}
          onValueChange={selectProfile}
          disabled={save.isPending}
          testID="agent-settings-profile-select"
        />
        <SettingsRow label={t("settings.host.agentSettingsProfiles.manage")}>
          <View style={styles.actions}>
            {save.isPending ? (
              <Text style={styles.saving} testID="agent-settings-profile-saving">
                {t("settings.host.orchestration.systemPrompt.saving")}
              </Text>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onPress={openCreate}
              testID="agent-settings-profile-create"
            >
              {t("settings.host.agentProfiles.newProfile")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onPress={openRename}
              testID="agent-settings-profile-rename"
            >
              {t("renameModal.rename")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending || bundle.profiles.length < 2}
              onPress={handleRemove}
              testID="agent-settings-profile-remove"
            >
              {t("settings.host.agentProfiles.remove")}
            </Button>
          </View>
        </SettingsRow>
        {save.error ? (
          <Alert
            variant="error"
            size="sm"
            description={save.error.message}
            testID="agent-settings-profile-error"
          />
        ) : null}
      </SettingsCard>
      {editor ? (
        <AdaptiveRenameModal
          key={`${editor}:${active.id}`}
          visible
          title={
            editor === "create"
              ? t("settings.host.agentProfiles.addProfileTitle")
              : t("renameModal.rename")
          }
          initialValue={editor === "rename" ? active.name : ""}
          submitLabel={t("settings.host.agentProfiles.save")}
          onClose={closeEditor}
          onSubmit={saveName}
          testID="agent-settings-profile-name"
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  saving: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
