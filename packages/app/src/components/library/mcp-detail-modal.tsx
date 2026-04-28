import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CheckCircle2, Pencil, Play, Trash2, XCircle } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { LibraryEntry, McpHttpPayload, McpStdioPayload } from "@/api/library";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";

export interface McpDetailModalProps {
  visible: boolean;
  onClose: () => void;
  entry: LibraryEntry | null;
  onEdit: (entry: LibraryEntry) => void;
  onUninstall: (entry: LibraryEntry) => Promise<void> | void;
  uninstallPending?: boolean;
}

interface TestState {
  status: "idle" | "running" | "ok" | "error";
  tools?: string[];
  toolCount?: number;
  durationMs?: number;
  serverInfo?: { name?: string; version?: string };
  error?: string;
}

/**
 * Manage + diagnose an installed MCP entry. Edit re-opens the Add modal in
 * edit mode; Test runs a live daemon-side probe (spawn/connect + listTools)
 * so the user can validate the config before syncing it to agents.
 */
export function McpDetailModal({
  visible,
  onClose,
  entry,
  onEdit,
  onUninstall,
  uninstallPending,
}: McpDetailModalProps) {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const payload = entry?.payload as (McpStdioPayload | McpHttpPayload) | undefined;
  const configLine = useMemo(() => {
    if (!payload) return "";
    if (payload.transport === "stdio") {
      const args = (payload.args ?? []).join(" ");
      return args ? `${payload.command} ${args}` : payload.command;
    }
    return payload.url;
  }, [payload]);

  const runTest = useCallback(async () => {
    if (!payload || !client) return;
    setTest({ status: "running" });
    try {
      const res = await client.libraryMcpTest(payload);
      if (res.ok) {
        setTest({
          status: "ok",
          tools: res.tools,
          toolCount: res.toolCount,
          durationMs: res.durationMs,
          serverInfo: res.serverInfo,
        });
      } else {
        setTest({
          status: "error",
          error: res.error ?? "Unknown error",
          durationMs: res.durationMs,
        });
      }
    } catch (err) {
      setTest({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }, [payload, client]);

  if (!entry || !payload) return null;

  return (
    <AdaptiveModalSheet title={entry.displayName || entry.name} visible={visible} onClose={onClose}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {entry.description ? <Text style={styles.description}>{entry.description}</Text> : null}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Transport</Text>
          <Text style={styles.mono}>{payload.transport}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            {payload.transport === "stdio" ? "Command" : "Endpoint"}
          </Text>
          <Text style={styles.mono} selectable>
            {configLine}
          </Text>
        </View>

        {payload.transport === "stdio" && payload.env && Object.keys(payload.env).length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Environment</Text>
            {Object.entries(payload.env).map(([k, v]) => (
              <Text key={k} style={styles.mono} selectable>
                {k}={v ? "••••" : "(empty)"}
              </Text>
            ))}
          </View>
        ) : null}

        <TestResultCard state={test} onRun={runTest} disabled={!client} />

        <View style={styles.actions}>
          <Pressable
            onPress={() => onEdit(entry)}
            style={({ hovered }) => [styles.btn, hovered && styles.btnHovered]}
            accessibilityRole="button"
          >
            <Pencil size={14} color="currentColor" />
            <Text style={styles.btnLabel}>Edit</Text>
          </Pressable>
          <Pressable
            onPress={() => void onUninstall(entry)}
            disabled={uninstallPending}
            style={({ hovered }) => [
              styles.btn,
              styles.btnDanger,
              hovered && !uninstallPending && styles.btnDangerHovered,
              uninstallPending && { opacity: 0.6 },
            ]}
            accessibilityRole="button"
          >
            <Trash2 size={14} color="currentColor" />
            <Text style={[styles.btnLabel, styles.btnLabelDanger]}>
              {uninstallPending ? "Uninstalling…" : "Uninstall"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

function TestResultCard({
  state,
  onRun,
  disabled,
}: {
  state: TestState;
  onRun: () => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.testHeader}>
        <Text style={styles.sectionLabel}>Connection test</Text>
        <Pressable
          onPress={onRun}
          disabled={disabled || state.status === "running"}
          style={({ hovered }) => [
            styles.runBtn,
            hovered && state.status !== "running" && styles.btnHovered,
            (disabled || state.status === "running") && { opacity: 0.6 },
          ]}
          accessibilityRole="button"
        >
          {state.status === "running" ? (
            <ActivityIndicator size="small" />
          ) : (
            <Play size={13} color="currentColor" />
          )}
          <Text style={styles.btnLabel}>
            {state.status === "running" ? "Testing…" : "Run test"}
          </Text>
        </Pressable>
      </View>

      {state.status === "ok" ? (
        <View style={[styles.resultCard, styles.resultOk]}>
          <View style={styles.resultHeader}>
            <CheckCircle2 size={14} color="currentColor" />
            <Text style={styles.resultHeaderLabel}>
              Connected · {state.toolCount} tool{state.toolCount === 1 ? "" : "s"}
              {state.durationMs !== undefined ? ` · ${state.durationMs}ms` : ""}
            </Text>
          </View>
          {state.serverInfo?.name ? (
            <Text style={styles.resultMeta}>
              {state.serverInfo.name}
              {state.serverInfo.version ? ` v${state.serverInfo.version}` : ""}
            </Text>
          ) : null}
          {state.tools && state.tools.length > 0 ? (
            <Text style={styles.mono} numberOfLines={6}>
              {state.tools.join(", ")}
            </Text>
          ) : null}
        </View>
      ) : state.status === "error" ? (
        <View style={[styles.resultCard, styles.resultErr]}>
          <View style={styles.resultHeader}>
            <XCircle size={14} color="currentColor" />
            <Text style={styles.resultHeaderLabel}>Failed</Text>
          </View>
          <Text style={styles.resultErrorText}>{state.error}</Text>
        </View>
      ) : null}

      {!disabled ? null : <Text style={styles.resultMeta}>Connect a daemon to run the test.</Text>}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  description: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
  },
  mono: {
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  testHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
  },
  resultCard: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    gap: 6,
  },
  resultOk: {
    borderColor: theme.colors.success,
    color: theme.colors.success,
  },
  resultErr: {
    borderColor: theme.colors.destructive,
    color: theme.colors.destructive,
  },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  resultHeaderLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600" as const,
    color: "currentColor",
  },
  resultMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  resultErrorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
  },
  btnHovered: {
    backgroundColor: theme.colors.surface2,
  },
  btnLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foreground,
  },
  btnDanger: {
    borderColor: theme.colors.destructive,
    backgroundColor: "transparent",
  },
  btnDangerHovered: {
    backgroundColor: theme.colors.destructive,
  },
  btnLabelDanger: {
    color: theme.colors.destructive,
  },
}));
