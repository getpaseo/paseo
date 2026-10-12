import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { FileActionItems } from "./action-items";

export function FileActionsToolbar({
  serverId,
  workspaceRoot,
  path,
}: {
  serverId: string;
  workspaceRoot: string;
  path: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const onStatus = useCallback((message: string, error = false) => {
    setStatus(message);
    setFailed(error);
  }, []);
  const target = useMemo(() => {
    const read = resolveFilePreviewReadTarget({ path, workspaceRoot });
    return read ? { serverId, ...read } : null;
  }, [serverId, path, workspaceRoot]);
  return (
    <View style={styles.bar}>
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          accessibilityLabel={t("fileAccess.actions")}
          testID="file-actions-trigger"
        >
          <Text style={styles.label}>{t("fileAccess.actions")} ▾</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <FileActionItems target={target} onStatus={onStatus} />
        </DropdownMenuContent>
      </DropdownMenu>
      {status ? (
        <Text style={failed ? styles.error : styles.hint} numberOfLines={2}>
          {status}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, flex: 1 },
  error: { color: theme.colors.destructive, flex: 1 },
}));
