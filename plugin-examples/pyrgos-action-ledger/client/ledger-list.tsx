import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  groupByState,
  missingFields,
  type ActionItem,
  type LedgerGroup,
} from "../shared/ledger-view";

export interface LedgerListColors {
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  danger: string;
}

export interface LedgerListProps {
  items: readonly ActionItem[];
  colors: LedgerListColors;
  compact: boolean;
}

function useStyles(colors: LedgerListColors, compact: boolean) {
  return useMemo(
    () => ({
      scroll: { flex: 1, backgroundColor: colors.background },
      screen: {
        flexGrow: 1,
        padding: compact ? 12 : 20,
        gap: 16,
        backgroundColor: colors.background,
      },
      group: { gap: 8 },
      entry: { gap: 2 },
      heading: { color: colors.accent, fontSize: 13, fontWeight: "600" as const },
      title: { color: colors.foreground, fontSize: 15 },
      detail: { color: colors.muted, fontSize: 12 },
      empty: { color: colors.muted },
      error: { color: colors.danger, fontSize: 12 },
    }),
    [colors, compact],
  );
}

type Styles = ReturnType<typeof useStyles>;

function ItemRow({ entry, styles }: { entry: ActionItem; styles: Styles }) {
  const missing = missingFields(entry);
  const open = entry.state === "draft" || entry.state === "refined";
  return (
    <View testID={`ledger-item-${entry.id}`} style={styles.entry}>
      <Text style={styles.title}>{entry.item}</Text>
      <Text style={styles.detail}>
        {[entry.project, entry.scope, entry.doneCriteria].filter(Boolean).join(" · ")}
      </Text>
      {open ? (
        <Text style={styles.detail}>
          {missing.length > 0 ? `Needs: ${missing.join(", ")}` : "Ready to confirm"}
        </Text>
      ) : null}
      {entry.launchError ? (
        <Text style={styles.error}>{`Launch failed: ${entry.launchError}`}</Text>
      ) : null}
      {entry.dropReason ? (
        <Text style={styles.detail}>{`Dropped: ${entry.dropReason}`}</Text>
      ) : null}
    </View>
  );
}

function GroupSection({ group, styles }: { group: LedgerGroup; styles: Styles }) {
  return (
    <View testID={`ledger-group-${group.state}`} style={styles.group}>
      <Text style={styles.heading}>{`${group.title} (${group.items.length})`}</Text>
      {group.items.length === 0 ? <Text style={styles.empty}>None</Text> : null}
      {group.items.map((entry) => (
        <ItemRow key={entry.id} entry={entry} styles={styles} />
      ))}
    </View>
  );
}

export function LedgerList({ items, colors, compact }: LedgerListProps) {
  const styles = useStyles(colors, compact);
  const groups = useMemo(() => groupByState(items), [items]);
  return (
    <ScrollView testID="ledger-list" style={styles.scroll} contentContainerStyle={styles.screen}>
      {groups.map((group) => (
        <GroupSection key={group.state} group={group} styles={styles} />
      ))}
    </ScrollView>
  );
}
