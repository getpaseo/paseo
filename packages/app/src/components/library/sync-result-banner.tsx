import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CheckCircle2, AlertTriangle } from "lucide-react-native";
import type { SyncLibraryResult } from "@/hooks/library/use-sync-library";

interface SyncResultBannerProps {
  error: string | null;
  lastResult: SyncLibraryResult | null;
  /** Hide the success banner after this many ms. */
  hideAfterMs?: number;
}

/**
 * Post-sync feedback. Shows three states:
 *  - Error: persistent red banner until the next sync resets it.
 *  - Running agents: yellow hint, persistent.
 *  - Success: green "Synced N item(s) across M agent(s)", auto-fades.
 */
export function SyncResultBanner({ error, lastResult, hideAfterMs = 6_000 }: SyncResultBannerProps) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!lastResult) return;
    setHidden(false);
    const t = setTimeout(() => setHidden(true), hideAfterMs);
    return () => clearTimeout(t);
  }, [lastResult, hideAfterMs]);

  if (error) {
    return (
      <View style={[styles.banner, styles.error]}>
        <AlertTriangle size={14} color="currentColor" />
        <Text style={styles.errorText}>Sync failed: {error}</Text>
      </View>
    );
  }

  if (!lastResult) return null;

  const runningCount = lastResult.runningAgentIds.length;
  if (runningCount > 0) {
    return (
      <View style={[styles.banner, styles.warn]}>
        <AlertTriangle size={14} color="currentColor" />
        <Text style={styles.warnText}>
          Synced. {runningCount} agent{runningCount === 1 ? "" : "s"} running — restart
          to pick up the new library.
        </Text>
      </View>
    );
  }

  if (hidden) return null;

  const { mcp, skill, targets } = summarize(lastResult);
  return (
    <View style={[styles.banner, styles.success]}>
      <CheckCircle2 size={14} color="currentColor" />
      <Text style={styles.successText}>
        Synced {describeCounts(mcp, skill)} across {targets} agent
        {targets === 1 ? "" : "s"}.
      </Text>
    </View>
  );
}

function summarize(result: SyncLibraryResult): { mcp: number; skill: number; targets: number } {
  let mcp = 0;
  let skill = 0;
  let targets = 0;
  for (const entry of Object.values(result.counts)) {
    if (entry.mcp === 0 && entry.skill === 0) continue;
    mcp += entry.mcp;
    skill += entry.skill;
    targets += 1;
  }
  return { mcp, skill, targets };
}

function describeCounts(mcp: number, skill: number): string {
  const parts: string[] = [];
  if (mcp > 0) parts.push(`${mcp} MCP${mcp === 1 ? "" : "s"}`);
  if (skill > 0) parts.push(`${skill} skill${skill === 1 ? "" : "s"}`);
  if (parts.length === 0) return "0 entries";
  return parts.join(" + ");
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
  },
  success: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
  },
  successText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  warn: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foregroundMuted,
  },
  warnText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    borderColor: theme.colors.destructive,
    backgroundColor: "transparent",
    color: theme.colors.destructive,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
}));
