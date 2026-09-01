import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Cloud, GitBranch, Tag } from "lucide-react-native";
import type { CommitLogRef } from "@getpaseo/protocol/messages";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";

const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedCloud = withUnistyles(Cloud);
const ThemedTag = withUnistyles(Tag);

const ICON_SIZE = 12;
// Past this the badges crowd the subject out, and the tail is never the
// interesting ref. The rest collapse into a +N badge.
const MAX_VISIBLE_BADGES = 3;

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

function badgeVariant(kind: CommitLogRef["kind"]): StatusBadgeVariant {
  if (kind === "head") return "success";
  if (kind === "tag") return "warning";
  return "muted";
}

function badgeLeading(kind: CommitLogRef["kind"]) {
  if (kind === "local_branch") {
    return <ThemedGitBranch size={ICON_SIZE} uniProps={mutedIconMapping} />;
  }
  if (kind === "remote_branch") {
    return <ThemedCloud size={ICON_SIZE} uniProps={mutedIconMapping} />;
  }
  if (kind === "tag") {
    return <ThemedTag size={ICON_SIZE} uniProps={warningIconMapping} />;
  }
  return null;
}

export function CommitRefBadges({ refs }: { refs: CommitLogRef[] }) {
  const visible = useMemo(() => refs.slice(0, MAX_VISIBLE_BADGES), [refs]);
  if (refs.length === 0) {
    return null;
  }
  const overflow = refs.length - visible.length;
  return (
    <View style={styles.row}>
      {visible.map((ref) => (
        <StatusBadge
          key={`${ref.kind}:${ref.name}`}
          label={ref.name}
          variant={badgeVariant(ref.kind)}
          leading={badgeLeading(ref.kind)}
        />
      ))}
      {overflow > 0 ? <StatusBadge label={`+${overflow}`} variant="muted" /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    // Never squeeze the subject to nothing to fit one more badge.
    flexShrink: 0,
  },
}));
