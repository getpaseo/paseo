import { useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { LiveElapsed } from "@/components/message";
import { createHostBackgroundWorkModel } from "./host";

function kindKey(kind: string): "shell" | "monitor" | "other" {
  if (kind === "shell" || kind === "monitor") return kind;
  return "other";
}

export function BackgroundWorkTrack({
  serverId,
  agentId,
  count,
}: {
  serverId: string;
  agentId: string;
  count: number;
}) {
  const model = useMemo(
    () => createHostBackgroundWorkModel(serverId, agentId),
    [serverId, agentId],
  );
  return <Track model={model} count={count} />;
}

function Track({
  model,
  count,
}: {
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  count: number;
}) {
  const { t } = useTranslation();
  const { items, status } = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  if (status === "ready" && items?.length === 0) return null;
  const visibleCount = items?.length || count;
  return (
    <ComposerTrackPill
      testID="background-work"
      panelTitle={t("message.backgroundWork.title")}
      segments={[
        { bucket: "running", text: `${t("message.backgroundWork.label")} · ${visibleCount}` },
      ]}
    >
      {status === "loading" || status === "stale" ? (
        <ComposerTrackRow>
          <Text style={styles.facts}>{t("message.backgroundWork.waiting")}</Text>
        </ComposerTrackRow>
      ) : null}
      {status === "error" ? (
        <>
          <ComposerTrackRow>
            <Text style={styles.facts}>{t("message.backgroundWork.error")}</Text>
          </ComposerTrackRow>
          <ComposerTrackRow
            onPress={model.retry}
            closeOnSelect={false}
            accessibilityLabel={t("message.backgroundWork.retry")}
          >
            <Text style={styles.title}>{t("message.backgroundWork.retry")}</Text>
          </ComposerTrackRow>
        </>
      ) : null}
      {items?.map((item) => {
        const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
        return (
          <ComposerTrackRow key={item.id}>
            <View style={styles.row}>
              <Text style={styles.title}>{item.description ?? kind}</Text>
              <Text style={styles.facts}>
                {kind} ·{" "}
                <LiveElapsed startedAt={new Date(item.startedAt)} active style={styles.facts} />
              </Text>
            </View>
          </ComposerTrackRow>
        );
      })}
    </ComposerTrackPill>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  facts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
