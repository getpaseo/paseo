import { useCallback } from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { MenuItem } from "@/components/ui/menu";
import { getDesktopHost } from "@/desktop/host";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { performFileAction, type FileAction } from "./actions";
import { fileExtension, type FileAccessTarget } from "./types";

export function FileActionItems({
  target,
  onPreview,
  onStatus,
  agentId,
}: {
  target: FileAccessTarget | null;
  agentId?: string;
  onPreview?(): void;
  onStatus(message: string, error?: boolean): void;
}) {
  const { t } = useTranslation();
  const { updateSettings } = useAppSettings();
  const run = useCallback(
    (action: FileAction, remember = false) => {
      if (!target) return;
      const client = useSessionStore.getState().sessions[target.serverId]?.client;
      if (!client) {
        onStatus(t("fileAccess.disconnected"), true);
        return;
      }
      onStatus(t("fileAccess.preparing"));
      let localCopy = false;
      void performFileAction({
        client,
        target,
        action,
        onLocalCopy: () => {
          localCopy = true;
        },
      })
        .then(async (application) => {
          if (remember && application)
            await updateSettings((current) => ({
              fileOpening: {
                ...current.fileOpening,
                byExtension: {
                  ...current.fileOpening.byExtension,
                  [fileExtension(target.path)]: { mode: "external", application },
                },
              },
            }));
          onStatus(
            localCopy && (action === "external" || action === "choose" || action === "reveal")
              ? t("fileAccess.localCopy")
              : "",
          );
          return application;
        })
        .catch((error) =>
          onStatus(error instanceof Error ? error.message : t("fileAccess.failed"), true),
        );
    },
    [target, onStatus, updateSettings, t],
  );
  const external = useCallback(() => run("external"), [run]);
  const choose = useCallback(() => run("choose"), [run]);
  const remember = useCallback(() => run("choose", true), [run]);
  const reveal = useCallback(() => run("reveal"), [run]);
  const save = useCallback(() => run("save"), [run]);
  const share = useCallback(() => run("share"), [run]);
  const copy = useCallback(() => {
    if (target)
      void Clipboard.setStringAsync(target.path).catch((error) => onStatus(String(error), true));
  }, [target, onStatus]);
  const addArtifact = useCallback(() => {
    if (!target || !agentId) return;
    const session = useSessionStore.getState().sessions[target.serverId];
    if (session?.serverInfo?.features?.taskArtifacts !== true) {
      onStatus(t("fileAccess.updateHost"), true);
      return;
    }
    void session.client
      ?.updateTaskArtifact(agentId, "add", target.path)
      .then((result) =>
        onStatus(result.error ?? t("fileAccess.artifactAdded"), Boolean(result.error)),
      )
      .catch((error) => onStatus(String(error), true));
  }, [target, agentId, onStatus, t]);
  const desktop = Boolean(getDesktopHost()?.files);
  return (
    <>
      {onPreview ? <MenuItem onSelect={onPreview}>{t("fileAccess.preview")}</MenuItem> : null}
      <MenuItem onSelect={external} disabled={!target}>
        {t("fileAccess.openOther")}
      </MenuItem>
      {desktop ? (
        <>
          <MenuItem onSelect={choose} disabled={!target}>
            {t("fileAccess.openWith")}
          </MenuItem>
          <MenuItem onSelect={remember} disabled={!target}>
            {t("fileAccess.rememberWith")}
          </MenuItem>
          <MenuItem onSelect={reveal} disabled={!target}>
            {t("fileAccess.reveal")}
          </MenuItem>
        </>
      ) : null}
      <MenuItem onSelect={save} disabled={!target}>
        {t("fileAccess.save")}
      </MenuItem>
      <MenuItem onSelect={share} disabled={!target}>
        {t("fileAccess.share")}
      </MenuItem>
      {agentId ? (
        <MenuItem onSelect={addArtifact} disabled={!target}>
          {t("fileAccess.addArtifact")}
        </MenuItem>
      ) : null}
      <MenuItem onSelect={copy} disabled={!target}>
        {t("fileAccess.copyPath")}
      </MenuItem>
    </>
  );
}
