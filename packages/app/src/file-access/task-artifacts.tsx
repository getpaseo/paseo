import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { TaskArtifactsList } from "./task-artifacts-list";

export function TaskArtifacts({
  serverId,
  agentId,
  onOpen,
}: {
  serverId: string;
  agentId: string;
  onOpen(target: { path: string }, disposition: "main"): void;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const header = useMemo(() => ({ title: t("fileAccess.artifacts") }), [t]);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const openFile = useCallback(
    (path: string) => {
      setVisible(false);
      onOpen({ path }, "main");
    },
    [onOpen],
  );
  return (
    <View style={styles.toolbar}>
      <Button variant="ghost" size="sm" onPress={open} testID="current-task-artifacts">
        {t("fileAccess.artifacts")}
      </Button>
      <AdaptiveModalSheet
        visible={visible}
        onClose={close}
        header={header}
        testID="task-artifacts-sheet"
      >
        {visible ? (
          <View style={styles.content}>
            <TaskArtifactsList serverId={serverId} agentId={agentId} onOpen={openFile} />
          </View>
        ) : null}
      </AdaptiveModalSheet>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  toolbar: { alignItems: "flex-end", paddingHorizontal: theme.spacing[3] },
  content: { height: 420 },
}));
