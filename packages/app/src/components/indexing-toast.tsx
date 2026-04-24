import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { usePathname } from "expo-router";
import { Check, X, XCircle } from "lucide-react-native";

import { IndexingProvider, useIndexing } from "@/hooks/use-indexing";
import { useSessionStore } from "@/stores/session-store";

/** Parse `/h/srv_xxx/…` to extract the active server id. */
function parseServerIdFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/h\/([^/]+)/);
  return match ? (match[1] ?? null) : null;
}

/**
 * Global toast for workspace indexing. Mounted once in the app shell and
 * reads the active server's indexing entries. Surfaces the most recent
 * workspace that's actively installing/indexing/errored, auto-dismisses
 * soon after it finishes (ready or error).
 *
 * Positioned above the DownloadToast so both can coexist without overlap.
 */

const AUTO_DISMISS_MS = 4000;
const TOAST_OFFSET = 76; // sits above DownloadToast (bottom + ~60px + gap)

export function IndexingToast() {
  const pathname = usePathname();
  const serverId = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  // The toast is the only consumer of indexing state outside a settings page,
  // so it owns its own provider. Without a serverId there's nothing to show.
  if (!serverId) return null;
  return (
    <IndexingProvider serverId={serverId}>
      <IndexingToastInner serverId={serverId} />
    </IndexingProvider>
  );
}

function IndexingToastInner({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const indexing = useIndexing();
  const workspaces = useSessionStore((s) => s.sessions[serverId]?.workspaces);

  // Most-recently active indexing entry — prefer error > indexing > installing.
  const active = useMemo(() => {
    const entries = indexing.entries ?? [];
    const picked =
      entries.find((e) => e.indexing?.status?.phase === "error") ??
      entries.find((e) => e.indexing?.status?.phase === "indexing") ??
      entries.find((e) => e.indexing?.status?.phase === "installing") ??
      null;
    if (!picked) return null;
    const status = picked.indexing?.status;
    if (!status) return null;
    const ws = workspaces?.get(picked.workspaceId);
    const label =
      ws?.projectDisplayName ||
      ws?.projectRootPath?.split("/").filter(Boolean).pop() ||
      picked.workspaceId;
    return {
      workspaceId: picked.workspaceId,
      label,
      phase: status.phase,
      progress: status.progress ?? null,
      fileCount: status.fileCount ?? null,
      error: status.error ?? null,
    };
  }, [indexing.entries, workspaces]);

  // Keep the toast visible for a moment after transitioning to "ready" so
  // the user sees completion. We mirror the active entry into local state
  // and swap to a terminal "ready" snapshot for the dismiss countdown.
  const [terminal, setTerminal] = useState<
    { kind: "ready" | "error"; label: string; detail: string | null } | null
  >(null);
  const lastActiveRef = useRef<typeof active>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = lastActiveRef.current;
    lastActiveRef.current = active;

    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
      dismissTimeoutRef.current = null;
    }

    // Active thing going → terminal thing gone (we're showing live status).
    if (active) {
      setTerminal(null);
      return;
    }

    // Was active, now nothing → show a brief "done" state.
    if (prev) {
      const kind = prev.phase === "error" ? "error" : "ready";
      setTerminal({
        kind,
        label: prev.label,
        detail:
          kind === "error"
            ? (prev.error ?? "Indexing failed")
            : prev.fileCount != null
              ? `Indexed ${prev.fileCount.toLocaleString()} files`
              : "Indexing complete",
      });
      dismissTimeoutRef.current = setTimeout(() => {
        setTerminal(null);
      }, AUTO_DISMISS_MS);
    }

    return () => {
      if (dismissTimeoutRef.current) clearTimeout(dismissTimeoutRef.current);
    };
  }, [active]);

  if (!active && !terminal) return null;

  return (
    <View
      style={[
        styles.container,
        {
          bottom: insets.bottom + TOAST_OFFSET,
          pointerEvents: "box-none",
        },
      ]}
    >
      <View style={styles.toast}>
        {active ? (
          active.phase === "error" ? (
            <XCircle size={18} color={theme.colors.destructive} />
          ) : (
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          )
        ) : terminal?.kind === "ready" ? (
          <Check size={18} color={theme.colors.primary} />
        ) : (
          <XCircle size={18} color={theme.colors.destructive} />
        )}

        <View style={styles.textContainer}>
          <Text style={styles.title} numberOfLines={1}>
            {active ? labelForPhase(active.phase, active.label) : `Indexed ${terminal?.label}`}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {active
              ? formatActiveDetail(active)
              : (terminal?.detail ?? (terminal?.kind === "ready" ? "Ready" : "Failed"))}
          </Text>
          {active && active.progress != null && active.phase === "indexing" ? (
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${Math.round(active.progress)}%` }]} />
            </View>
          ) : null}
        </View>

        {!active && terminal ? (
          <Pressable onPress={() => setTerminal(null)} hitSlop={8} style={styles.dismiss}>
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function labelForPhase(phase: string, label: string): string {
  if (phase === "installing") return `Installing code-review-graph for ${label}`;
  if (phase === "indexing") return `Indexing ${label}`;
  if (phase === "error") return `Indexing failed: ${label}`;
  return label;
}

function formatActiveDetail(active: {
  phase: string;
  progress: number | null;
  fileCount: number | null;
  error: string | null;
}): string {
  if (active.phase === "error") return active.error ?? "Unknown error";
  const parts: string[] = [];
  if (active.progress != null) parts.push(`${Math.round(active.progress)}%`);
  if (active.fileCount != null) parts.push(`${active.fileCount.toLocaleString()} files`);
  if (parts.length === 0) return active.phase === "installing" ? "Starting…" : "Starting…";
  return parts.join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: 999,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    ...theme.shadow.md,
  },
  textContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  progressBar: {
    height: 3,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.full,
    marginTop: theme.spacing[1],
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.full,
  },
  dismiss: {
    padding: theme.spacing[1],
  },
}));
