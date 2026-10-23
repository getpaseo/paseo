import { useQuery } from "@tanstack/react-query";
import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { ActionItem } from "../shared/ledger-view";
import { listActionItemsRpc } from "../shared/list-rpc";
import { LedgerList } from "./ledger-list";

const POLL_MS = 2000;
const NO_ITEMS: ActionItem[] = [];

export function ActionLedgerPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const listItems = useRpc(listActionItemsRpc);
  const { data, error } = useQuery({
    queryKey: ["pyrgos-action-ledger", workspaceId],
    queryFn: () => listItems({}),
    refetchInterval: POLL_MS,
  });
  const { colors, styles } = useMemo(() => {
    const palette = {
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      muted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
      danger: theme.colors.statusDanger,
    };
    return {
      colors: palette,
      styles: {
        root: { flex: 1, backgroundColor: palette.background },
        error: { color: palette.danger, padding: 12 },
        muted: { color: palette.muted, padding: 12 },
      },
    };
  }, [theme]);
  return (
    <View style={styles.root}>
      {error ? <Text style={styles.error}>{error.message}</Text> : null}
      {data && !data.session ? (
        <Text style={styles.muted}>No voice session ledger yet.</Text>
      ) : null}
      <LedgerList items={data?.items ?? NO_ITEMS} colors={colors} compact={layout.compact} />
    </View>
  );
}
