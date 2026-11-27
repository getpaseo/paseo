import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { createHostBackgroundWorkModel } from "@/background-work";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { getForgePresentation } from "@/git/forge";
import type { PrHint } from "@/git/pr-hint";
import { useWorkspacePrHint } from "@/git/use-pr-status-query";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { openExternalUrl } from "@/utils/open-external-url";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { useStartPrWatch } from "./use-start-watch";

type BackgroundWorkModel = ReturnType<typeof createHostBackgroundWorkModel>;
interface ComposerWatchProps {
  serverId: string;
  workspaceId: string;
  agentId: string;
  backgroundWork: BackgroundWorkModel;
}

const CHECK_MARKS: Record<NonNullable<PrHint["checksStatus"]>, SidebarStateBucket | null> = {
  none: null,
  pending: "running",
  success: "done",
  failure: "failed",
};

export function ComposerPrWatch({
  serverId,
  workspaceId,
  agentId,
  backgroundWork,
}: ComposerWatchProps) {
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const eligible = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return Boolean(agent && !agent.background && !agent.archivedAt && agent.status !== "closed");
  });
  const pr = useWorkspacePrHint({ serverId, cwd, enabled: eligible });
  if (!eligible || pr?.state !== "open") return null;
  return (
    <OpenPrWatch
      key={JSON.stringify([serverId, agentId, pr.url])}
      serverId={serverId}
      agentId={agentId}
      pr={pr}
      backgroundWork={backgroundWork}
    />
  );
}

function OpenPrWatch({
  serverId,
  agentId,
  pr,
  backgroundWork,
}: Omit<ComposerWatchProps, "workspaceId"> & { pr: PrHint }) {
  const { t } = useTranslation();
  const {
    changeRequestAbbrev: abbreviation,
    numberPrefix,
    brandLabel,
  } = getForgePresentation(pr.forge);
  const { start, pending, error, supported } = useStartPrWatch(serverId, pr.url, abbreviation);
  const inventory = useSyncExternalStore(backgroundWork.subscribe, backgroundWork.getSnapshot);
  const watching =
    inventory.items?.some(
      (item) => item.changeRequestUrl && sameChangeRequestUrl(pr, item.changeRequestUrl),
    ) ?? false;
  const reference = `${numberPrefix}${pr.number}`;
  const label = watching
    ? t("workspace.git.pr.watch.watching", { reference })
    : `${abbreviation} ${reference}`;
  const mark = CHECK_MARKS[pr.checksStatus ?? "none"] ?? null;
  const segments = useMemo(() => [{ text: label, bucket: mark }], [label, mark]);

  const open = useCallback(() => {
    void openExternalUrl(pr.url);
  }, [pr.url]);
  const watch = useCallback(() => {
    void start(agentId);
  }, [agentId, start]);

  return (
    <ComposerTrackPill segments={segments} panelTitle={label} testID="composer-pr-watch">
      {watching ? (
        <ComposerTrackRow>
          <Text style={styles.hint}>{t("workspace.git.pr.watch.manage")}</Text>
        </ComposerTrackRow>
      ) : null}
      {supported && !watching ? (
        <ComposerTrackRow
          onPress={watch}
          disabled={pending}
          closeOnSelect={false}
          testID="composer-pr-watch-start"
        >
          <Text style={styles.action}>
            {pending ? t("workspace.git.pr.watch.starting") : t("workspace.git.pr.watch.thisAgent")}
          </Text>
        </ComposerTrackRow>
      ) : null}
      {error ? (
        <ComposerTrackRow>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        </ComposerTrackRow>
      ) : null}
      <ComposerTrackRow onPress={open}>
        <Text style={styles.action}>
          {t("workspace.git.pr.actions.openOn", { brand: brandLabel })}
        </Text>
      </ComposerTrackRow>
    </ComposerTrackPill>
  );
}

function sameChangeRequestUrl(pr: Pick<PrHint, "url" | "forge">, watchedUrl: string): boolean {
  if (pr.url === watchedUrl) return true;
  return changeRequestIdentity(pr.url, pr.forge) === changeRequestIdentity(watchedUrl, pr.forge);
}

function changeRequestIdentity(value: string, forge: PrHint["forge"]): string {
  try {
    const url = new URL(value);
    let path = decodeURI(url.pathname).replace(/\/$/, "");
    if (forge === "github") path = path.toLowerCase();
    else if (forge !== "gitlab") {
      path = path.replace(/\/[^/]+\/[^/]+\/pulls\/\d+$/i, (suffix) => suffix.toLowerCase());
    }
    path = path.replace(/\/(?:-\/)?merge_requests\//, "/-/merge_requests/");
    return `${url.origin}${path}`;
  } catch {
    return value;
  }
}

const styles = StyleSheet.create((theme) => ({
  action: { color: theme.colors.foreground },
  hint: { color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive },
}));
