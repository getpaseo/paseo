import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Download,
  Network,
  RefreshCw,
} from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { IndexingStatusBar } from "@/components/indexing-status-bar";
import {
  IndexingProvider,
  useIndexing,
  type FsTriggerInfo,
  type IndexingWorkspaceEntry,
} from "@/hooks/use-indexing";
import { settingsStyles } from "@/styles/settings";
import { IndexingProjectModal } from "@/screens/settings/indexing-project-modal";

interface IndexingSectionProps {
  routeServerId: string;
}

export function IndexingSection({ routeServerId }: IndexingSectionProps) {
  return (
    <IndexingProvider serverId={routeServerId}>
      <IndexingSectionInner routeServerId={routeServerId} />
    </IndexingProvider>
  );
}

function IndexingSectionInner({ routeServerId }: IndexingSectionProps) {
  const { theme } = useUnistyles();
  const indexing = useIndexing();
  const [detailWorkspaceId, setDetailWorkspaceId] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string>("");
  const [installSteps, setInstallSteps] = useState<
    Array<{ command: string; status: "running" | "ok" | "fail"; exitCode?: number | null }>
  >([]);
  const [installPlan, setInstallPlan] = useState<{
    kind: "pipx" | "brew-then-pipx" | "python3-bootstrap-pipx" | "unsupported";
    reason?: string;
  } | null>(null);
  const [installStartedAt, setInstallStartedAt] = useState<number | null>(null);
  const [, setInstallTick] = useState(0);
  // Tick once a second while installing so the elapsed-seconds counter
  // re-renders without subscribing every component.
  useEffect(() => {
    if (!installing) return;
    const handle = setInterval(() => setInstallTick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, [installing]);
  const installElapsedSec = installStartedAt
    ? Math.max(0, Math.floor((Date.now() - installStartedAt) / 1000))
    : 0;
  const detailEntry = useMemo(
    () => indexing.entries.find((e) => e.workspaceId === detailWorkspaceId) ?? null,
    [indexing.entries, detailWorkspaceId],
  );

  // Always offer Install when crg is missing — the daemon's planner picks
  // the right strategy (pipx, brew→pipx, or python3-bootstrap-pipx) based
  // on what's actually present. If no strategy fits, the install log
  // surfaces the reason. `process.platform` checks here are unreliable in
  // the renderer (RN/web) so we delegate to the daemon.
  const canAutoInstall = !!indexing.detection && !indexing.detection.codeReviewGraph.installed;

  const startInstall = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setInstallLog("");
    setInstallSteps([]);
    setInstallPlan(null);
    setInstallStartedAt(Date.now());
    const onEvent = (event: unknown) => {
      const e = event as {
        type: string;
        text?: string;
        stream?: string;
        command?: string;
        args?: string[];
        exitCode?: number | null;
        success?: boolean;
        error?: string;
        strategy?: {
          kind: "pipx" | "brew-then-pipx" | "python3-bootstrap-pipx" | "unsupported";
          reason?: string;
        };
      };
      if (e.type === "plan" && e.strategy) {
        setInstallPlan(e.strategy);
        setInstallLog(
          (prev) =>
            prev +
            `\n▸ Strategy: ${describePlan(e.strategy as { kind: string; reason?: string })}\n`,
        );
      } else if (e.type === "step-output" && e.text) {
        setInstallLog((prev) => prev + e.text);
      } else if (e.type === "step-started") {
        const cmd = `${e.command ?? ""} ${(e.args ?? []).join(" ")}`.trim();
        setInstallSteps((prev) => [...prev, { command: cmd, status: "running" }]);
        setInstallLog((prev) => prev + `\n$ ${cmd}\n`);
      } else if (e.type === "step-completed") {
        setInstallSteps((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last) {
            last.status = e.exitCode === 0 ? "ok" : "fail";
            last.exitCode = e.exitCode ?? null;
          }
          return next;
        });
        setInstallLog((prev) => prev + `\n(exit ${e.exitCode ?? "null"})\n`);
      } else if (e.type === "completed") {
        setInstallLog(
          (prev) =>
            prev + (e.success ? "\n✔ Install complete" : `\n✘ Install failed: ${e.error ?? ""}`),
        );
      }
    };
    try {
      const outcome = await indexing.install(onEvent);
      if (!outcome.success && outcome.error) {
        setInstallLog((prev) => prev + `\n${outcome.error}`);
      }
    } catch (err) {
      // Catch the ack-timeout / transport rejection so it surfaces in the UI
      // log instead of bubbling as an unhandled promise rejection.
      const message = err instanceof Error ? err.message : String(err);
      setInstallLog(
        (prev) =>
          prev +
          `\n✘ ${message}\n\nThe install may still be running on the daemon. Re-checking detection…`,
      );
      // The event channel may have broken (WS reconnect, etc.) while the
      // daemon kept installing. Refresh detection — if crg is now present,
      // the failure becomes invisible and the UI flips to "installed".
      try {
        const det = await indexing.redetect();
        if (det?.codeReviewGraph.installed) {
          setInstallLog((prev) => prev + "\n✔ Detected after re-check — install succeeded.");
        }
      } catch {
        /* ignore — user can click Re-check manually */
      }
    } finally {
      setInstalling(false);
    }
  }, [installing, indexing]);

  const installedStatus = useMemo(() => {
    if (!indexing.detection) return "unknown" as const;
    if (indexing.detection.codeReviewGraph.installed) return "installed" as const;
    return "missing" as const;
  }, [indexing.detection]);

  const copyInstallCommand = useCallback(() => {
    const cmd = indexing.detection?.suggestedInstall ?? "";
    if (!cmd) return;
    if (typeof navigator !== "undefined" && "clipboard" in navigator) {
      void navigator.clipboard.writeText(cmd);
    }
  }, [indexing.detection?.suggestedInstall]);

  return (
    <View>
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>Code Indexing</Text>
      </View>
      <Text style={[settingsStyles.rowHint, { marginBottom: 12, marginLeft: 4 }]}>
        Give agents a structural graph of your code via code-review-graph (~28 MCP tools). Agents
        see only workspaces you opt in.
      </Text>

      <IndexingStatusBar serverId={routeServerId} />

      {installedStatus === "missing" && indexing.detection ? (
        <View
          style={{
            padding: 12,
            marginBottom: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={16} color={theme.colors.foreground} />
            <Text style={settingsStyles.rowTitle}>code-review-graph is not installed</Text>
          </View>
          {indexing.detection.suggestedInstall ? (
            <Text
              selectable
              style={{ fontFamily: "monospace", color: theme.colors.foregroundMuted, fontSize: 12 }}
            >
              {indexing.detection.suggestedInstall}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {canAutoInstall ? (
              <Button variant="default" onPress={startInstall} size="sm" disabled={installing}>
                <Download size={14} color="#ffffff" />
                <Text style={{ color: "#ffffff", marginLeft: 6 }}>
                  {installing ? "Installing…" : "Install"}
                </Text>
              </Button>
            ) : null}
            <Button variant="secondary" onPress={copyInstallCommand} size="sm">
              <Clipboard size={14} color={theme.colors.foreground} />
              <Text style={{ color: theme.colors.foreground, marginLeft: 6 }}>Copy command</Text>
            </Button>
            <Button variant="secondary" onPress={() => indexing.redetect()} size="sm">
              <RefreshCw size={14} color={theme.colors.foreground} />
              <Text style={{ color: theme.colors.foreground, marginLeft: 6 }}>Re-check</Text>
            </Button>
          </View>
          {installing || installSteps.length > 0 || installLog ? (
            <View
              style={{
                marginTop: 6,
                padding: 10,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
                gap: 6,
              }}
            >
              {installing ? (
                <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                  ⏳ Installing — {installElapsedSec}s elapsed (pip can take 1–2 min on first run)
                </Text>
              ) : null}
              {installPlan ? (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontFamily: "monospace",
                  }}
                >
                  Strategy: {describePlan(installPlan)}
                </Text>
              ) : null}
              {installSteps.length > 0 ? (
                <View style={{ gap: 2 }}>
                  {installSteps.map((step, idx) => {
                    const icon = step.status === "running" ? "•" : step.status === "ok" ? "✔" : "✘";
                    const color =
                      step.status === "running"
                        ? theme.colors.foregroundMuted
                        : step.status === "ok"
                          ? theme.colors.foreground
                          : theme.colors.foreground;
                    return (
                      <Text
                        key={`${idx}-${step.command}`}
                        style={{
                          fontFamily: "monospace",
                          color,
                          fontSize: 11,
                        }}
                      >
                        {icon} step {idx + 1}/{installSteps.length}: {step.command}
                        {step.status === "fail" ? `  (exit ${step.exitCode ?? "null"})` : ""}
                      </Text>
                    );
                  })}
                </View>
              ) : installing ? (
                <Text
                  style={{
                    fontFamily: "monospace",
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                  }}
                >
                  Starting installer…
                </Text>
              ) : null}
              {installLog ? (
                <ScrollView
                  style={{
                    maxHeight: 220,
                    marginTop: 4,
                    padding: 6,
                    borderRadius: 4,
                    backgroundColor: theme.colors.surface1,
                  }}
                >
                  <Text
                    selectable
                    style={{
                      fontFamily: "monospace",
                      color: theme.colors.foregroundMuted,
                      fontSize: 10,
                      lineHeight: 14,
                    }}
                  >
                    {installLog.trim()}
                  </Text>
                </ScrollView>
              ) : null}
              {!installing && installSteps.some((s) => s.status === "fail") ? (
                <View
                  style={{
                    marginTop: 4,
                    padding: 8,
                    borderRadius: 4,
                    backgroundColor: theme.colors.surface1,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 12, marginBottom: 4 }}>
                    Install failed. Common fixes on macOS:
                  </Text>
                  <Text
                    selectable
                    style={{
                      fontFamily: "monospace",
                      color: theme.colors.foregroundMuted,
                      fontSize: 11,
                    }}
                  >
                    {`# If you see "externally-managed-environment" (PEP 668),\n# Apple's system Python blocks --user installs. Use Homebrew:\nbrew install pipx\npipx install git+https://github.com/hubtool/code-review-graph.git\n# Then click Re-check.`}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={settingsStyles.card}>
        <StatusRow
          label="code-review-graph"
          value={
            indexing.detection?.codeReviewGraph.installed
              ? (indexing.detection.codeReviewGraph.version ?? "installed")
              : "not installed"
          }
          ok={installedStatus === "installed"}
          firstRow
        />
        <StatusRow
          label="pipx"
          value={
            indexing.detection?.pipx.installed
              ? (indexing.detection.pipx.version ?? "installed")
              : "not installed"
          }
          ok={!!indexing.detection?.pipx.installed}
        />
        <StatusRow
          label="python3"
          value={
            indexing.detection?.python3.installed
              ? (indexing.detection.python3.version ??
                (indexing.detection.python3.meetsMinimumVersion ? "ok" : "installed"))
              : "not installed"
          }
          ok={!!indexing.detection?.python3.meetsMinimumVersion}
        />
      </View>

      <View style={{ marginTop: 16, marginBottom: 8, marginLeft: 4 }}>
        <Text style={settingsStyles.sectionTitle}>Projects</Text>
        <Text style={settingsStyles.rowHint}>
          Toggle indexing per workspace. Tools become available to agents running in that workspace.
        </Text>
      </View>

      {indexing.isLoading ? (
        <Text style={[settingsStyles.rowHint, { marginLeft: 4 }]}>Loading projects…</Text>
      ) : indexing.entries.length === 0 ? (
        <Text style={[settingsStyles.rowHint, { marginLeft: 4 }]}>
          No workspaces yet — open a project from the sidebar to make it indexable.
        </Text>
      ) : (
        <View style={settingsStyles.card}>
          {indexing.entries.map((entry, idx) => (
            <ProjectRow
              key={entry.workspaceId}
              entry={entry}
              firstRow={idx === 0}
              fsTrigger={
                indexing.lastFsTrigger?.workspaceId === entry.workspaceId
                  ? indexing.lastFsTrigger
                  : null
              }
              onToggle={(enabled) => {
                void indexing.setEnabled(entry.workspaceId, enabled);
              }}
              onOpenDetails={() => setDetailWorkspaceId(entry.workspaceId)}
              onReindex={() => {
                void indexing.reindex(entry.workspaceId);
              }}
              onCancel={() => {
                void indexing.cancelReindex(entry.workspaceId);
              }}
            />
          ))}
        </View>
      )}

      <View style={{ marginTop: 12, flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button variant="ghost" onPress={indexing.refetch} size="sm">
          <RefreshCw size={14} color={theme.colors.foreground} />
          <Text style={{ color: theme.colors.foreground, marginLeft: 6 }}>Refresh</Text>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => {
            void indexing.restartSubprocess();
          }}
        >
          <RefreshCw size={14} color={theme.colors.foreground} />
          <Text style={{ color: theme.colors.foreground, marginLeft: 6 }}>Restart crg</Text>
        </Button>
        <Button variant="ghost" size="sm" onPress={() => setLogsOpen(true)}>
          <Text style={{ color: theme.colors.foreground }}>View logs</Text>
        </Button>
      </View>

      <LocalEmbeddingLimitsCard routeServerId={routeServerId} entries={indexing.entries} />

      <StderrLogsDrawer
        visible={logsOpen}
        fetchStderrTail={indexing.fetchStderrTail}
        onClose={() => setLogsOpen(false)}
      />

      <IndexingProjectModal
        serverId={routeServerId}
        entry={detailEntry}
        visible={detailWorkspaceId !== null}
        onClose={() => setDetailWorkspaceId(null)}
      />
    </View>
  );
}

// Knobs for the in-process Hubcode Local embedding pipeline. Daemon-wide
// (not per-workspace) — they cap memory the daemon allocates, which is
// shared across every workspace using the local provider.
//
// Hidden when no workspace is using `hubcode-local` so we don't expose
// daemon-internal ML knobs to users on remote-only providers.
function LocalEmbeddingLimitsCard({
  routeServerId,
  entries,
}: {
  routeServerId: string;
  entries: IndexingWorkspaceEntry[];
}) {
  const { theme } = useUnistyles();
  const { config, patchConfig } = useDaemonConfig(routeServerId);
  const indexingCfg = config?.indexing ?? {};

  const localWorkspaces = useMemo(
    () => entries.filter((e) => e.indexing?.embeddingProvider?.kind === "hubcode-local"),
    [entries],
  );

  const [maxFiles, setMaxFiles] = useState<string>("");
  const [maxRssMb, setMaxRssMb] = useState<string>("");
  const [batchSize, setBatchSize] = useState<string>("");
  const [maxInputs, setMaxInputs] = useState<string>("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setMaxFiles(indexingCfg.localEmbedMaxFiles?.toString() ?? "");
    setMaxRssMb(indexingCfg.daemonMaxRssMb?.toString() ?? "");
    setBatchSize(indexingCfg.localBatchSize?.toString() ?? "");
    setMaxInputs(indexingCfg.localInferMaxInputs?.toString() ?? "");
  }, [
    indexingCfg.localEmbedMaxFiles,
    indexingCfg.daemonMaxRssMb,
    indexingCfg.localBatchSize,
    indexingCfg.localInferMaxInputs,
  ]);

  const parseOptionalPositiveInt = (input: string): number | undefined => {
    const trimmed = input.trim();
    if (trimmed === "") return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  };

  const handleSave = useCallback(async () => {
    const patch: {
      localEmbedMaxFiles?: number;
      daemonMaxRssMb?: number;
      localBatchSize?: number;
      localInferMaxInputs?: number;
    } = {};
    const fields: Array<
      [string, "localEmbedMaxFiles" | "daemonMaxRssMb" | "localBatchSize" | "localInferMaxInputs"]
    > = [
      [maxFiles, "localEmbedMaxFiles"],
      [maxRssMb, "daemonMaxRssMb"],
      [batchSize, "localBatchSize"],
      [maxInputs, "localInferMaxInputs"],
    ];
    for (const [raw, key] of fields) {
      const value = parseOptionalPositiveInt(raw);
      if (value === undefined) continue;
      patch[key] = value;
    }
    await patchConfig({ indexing: patch });
    setSavedAt(Date.now());
  }, [maxFiles, maxRssMb, batchSize, maxInputs, patchConfig]);

  // Hide entirely when nobody is using the local provider — these limits
  // protect the daemon from OOM during local embedding, so they're noise
  // for users on OpenAI/Voyage/etc.
  if (localWorkspaces.length === 0) {
    return null;
  }

  const justSaved = savedAt !== null && Date.now() - savedAt < 3000;
  const affectedNames = localWorkspaces
    .map((e) => e.workspaceId.split("/").pop() ?? e.workspaceId)
    .slice(0, 5);
  const affectedSummary =
    localWorkspaces.length === 1
      ? `Affects ${affectedNames[0]}.`
      : localWorkspaces.length <= 5
        ? `Affects ${affectedNames.join(", ")}.`
        : `Affects ${affectedNames.join(", ")} and ${localWorkspaces.length - 5} more.`;

  return (
    <View style={limitStyles.section}>
      <View style={limitStyles.header}>
        <Text style={settingsStyles.sectionTitle}>Local embedding limits</Text>
        <Text style={limitStyles.affectedTag}>
          Daemon-wide · {localWorkspaces.length} workspace
          {localWorkspaces.length === 1 ? "" : "s"}
        </Text>
      </View>

      <View style={[settingsStyles.card, limitStyles.cardPadding]}>
        <Text style={limitStyles.help}>
          Hubcode Local runs the embedding model inside the daemon process, so very large repos can
          OOM-crash it. Raise these only if your machine has headroom; lower them if the daemon
          keeps crashing during indexing. Empty fields use the safe default.
        </Text>
        <Text style={limitStyles.affectedLine}>{affectedSummary}</Text>

        <View style={limitStyles.fieldsGroup}>
          <LimitField
            label="Max files per workspace"
            help="Block reindex when a workspace exceeds this many files."
            placeholder="1500 (default)"
            value={maxFiles}
            onChange={setMaxFiles}
            theme={theme}
          />
          <LimitField
            label="Daemon RSS ceiling"
            help="Abort indexing if daemon memory crosses this. Units in MB."
            placeholder="6144 (default · 6 GB)"
            value={maxRssMb}
            onChange={setMaxRssMb}
            theme={theme}
          />
          <LimitField
            label="Batch size"
            help="Items per embedding call. Smaller = safer + slower."
            placeholder="8 (default)"
            value={batchSize}
            onChange={setBatchSize}
            theme={theme}
          />
          <LimitField
            label="Max inputs per call"
            help="Hard upper bound on a single embedding request."
            placeholder="5000 (default)"
            value={maxInputs}
            onChange={setMaxInputs}
            theme={theme}
          />
        </View>

        <View style={limitStyles.actionsRow}>
          <Button onPress={handleSave} variant="secondary" size="sm">
            Save limits
          </Button>
          <Text style={[limitStyles.savedHint, !justSaved && limitStyles.savedHintHidden]}>
            Saved — applies on the next reindex.
          </Text>
        </View>
      </View>
    </View>
  );
}

function LimitField({
  label,
  help,
  value,
  onChange,
  placeholder,
  theme,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  theme: ReturnType<typeof useUnistyles>["theme"];
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={limitStyles.fieldRow}>
      <View style={limitStyles.fieldLabelGroup}>
        <Text style={limitStyles.fieldLabel}>{label}</Text>
        <Text style={limitStyles.fieldHelp}>{help}</Text>
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        keyboardType="number-pad"
        inputMode="numeric"
        selectTextOnFocus
        style={[
          limitStyles.input,
          {
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface0,
            borderColor: focused ? theme.colors.accent : theme.colors.border,
          },
        ]}
      />
    </View>
  );
}

const limitStyles = StyleSheet.create((theme) => ({
  section: {
    marginTop: theme.spacing[6],
  },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
    gap: theme.spacing[2],
  },
  affectedTag: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  cardPadding: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  help: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  affectedLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  fieldsGroup: {
    gap: theme.spacing[1],
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    gap: theme.spacing[4],
  },
  fieldLabelGroup: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  fieldLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  fieldHelp: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  input: {
    width: 180,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    fontSize: theme.fontSize.sm,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
    paddingTop: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  savedHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    transitionDuration: "200ms",
  },
  savedHintHidden: {
    opacity: 0,
  },
}));

function StatusRow({
  label,
  value,
  ok,
  firstRow,
}: {
  label: string;
  value: string;
  ok: boolean;
  firstRow?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={[settingsStyles.row, !firstRow && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {ok ? (
          <CheckCircle2 size={14} color={theme.colors.foreground} />
        ) : (
          <Network size={14} color={theme.colors.foregroundMuted} />
        )}
        <Text style={settingsStyles.rowHint}>{value}</Text>
      </View>
    </View>
  );
}

function ProjectRow({
  entry,
  onToggle,
  onOpenDetails,
  onReindex,
  onCancel,
  firstRow,
  fsTrigger,
}: {
  entry: IndexingWorkspaceEntry;
  onToggle: (enabled: boolean) => void;
  onOpenDetails: () => void;
  onReindex: () => void;
  onCancel: () => void;
  firstRow?: boolean;
  fsTrigger: FsTriggerInfo | null;
}) {
  const { theme } = useUnistyles();
  const state = entry.indexing;
  const enabled = state?.enabled ?? false;
  const phase = state?.status.phase ?? "idle";
  const nodeCount = state?.status.nodeCount;
  const fileCount = state?.status.fileCount;
  const lastIndexedAt = state?.status.lastIndexedAt;
  const progress = state?.status.progress;
  const indexBytes = state?.status.indexBytes;
  const showProgress = enabled && (phase === "indexing" || phase === "installing");
  return (
    <Pressable
      style={[settingsStyles.row, !firstRow && settingsStyles.rowBorder]}
      onPress={onOpenDetails}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{entry.workspaceId}</Text>
        <Text style={settingsStyles.rowHint}>
          {enabled
            ? phaseLabel(phase, fileCount, nodeCount, lastIndexedAt, progress, indexBytes)
            : "disabled"}
        </Text>
        {showProgress ? <IndexingProgressBar progress={progress} /> : null}
        {fsTrigger ? <FsTriggerHint trigger={fsTrigger} /> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {enabled && phase === "indexing" ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onCancel();
            }}
            hitSlop={6}
            accessibilityLabel="Cancel indexing"
            style={{
              paddingVertical: 4,
              paddingHorizontal: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>Cancel</Text>
          </Pressable>
        ) : null}
        {enabled ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onReindex();
            }}
            hitSlop={6}
            style={{
              padding: 6,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <RefreshCw
              size={14}
              color={phase === "indexing" ? theme.colors.foregroundMuted : theme.colors.foreground}
            />
          </Pressable>
        ) : null}
        <Switch
          value={enabled}
          onValueChange={onToggle}
          trackColor={{ false: theme.colors.surface2, true: theme.colors.foreground }}
        />
        <ChevronRight size={14} color={theme.colors.foregroundMuted} />
      </View>
    </Pressable>
  );
}

function phaseLabel(
  phase: string,
  fileCount?: number,
  nodeCount?: number,
  lastIndexedAt?: string,
  progress?: number,
  indexBytes?: number,
): string {
  switch (phase) {
    case "ready": {
      const parts: string[] = [];
      if (fileCount != null) parts.push(`${fileCount.toLocaleString()} files`);
      if (nodeCount != null) parts.push(`${nodeCount.toLocaleString()} nodes`);
      if (indexBytes != null) parts.push(formatBytes(indexBytes));
      if (lastIndexedAt) {
        const ts = new Date(lastIndexedAt);
        if (!Number.isNaN(ts.getTime())) parts.push(`indexed ${formatRelative(ts)}`);
      }
      return parts.length > 0 ? `Ready — ${parts.join(" · ")}` : "Ready";
    }
    case "indexing": {
      const parts: string[] = [];
      if (progress != null) parts.push(`${Math.round(progress)}%`);
      if (fileCount != null) parts.push(`${fileCount.toLocaleString()} files`);
      return parts.length > 0 ? `Indexing… ${parts.join(" · ")}` : "Indexing…";
    }
    case "installing":
      return "Installing…";
    case "error":
      return "Error";
    default:
      return fileCount != null ? `Idle — ${fileCount.toLocaleString()} files` : "Idle";
  }
}

/**
 * Thin progress bar under the row hint. Renders determinate when a
 * percentage is known (daemon emits `progress`), otherwise falls back to
 * an indeterminate shimmer so the user still sees that work is happening.
 */
function IndexingProgressBar({ progress }: { progress?: number }): React.JSX.Element {
  const { theme } = useUnistyles();
  const shimmer = useRef(new Animated.Value(0)).current;
  const determinate = progress != null;

  useEffect(() => {
    if (determinate) return;
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
        // Gate: native driver isn't implemented on RN web/Electron.
        useNativeDriver: !isWeb,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [determinate, shimmer]);

  const trackHeight = 3;
  const commonTrack = {
    marginTop: 6,
    height: trackHeight,
    borderRadius: trackHeight / 2,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden" as const,
  };

  if (determinate) {
    const pct = Math.max(0, Math.min(100, progress ?? 0));
    return (
      <View style={commonTrack}>
        <View
          style={{
            width: `${pct}%`,
            height: "100%",
            backgroundColor: theme.colors.foreground,
            borderRadius: trackHeight / 2,
          }}
        />
      </View>
    );
  }

  // Indeterminate: a short bar slides across the full track width.
  // Width of the sliding bar is 30% of the track; it travels from -30% to 100%.
  const translate = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: ["-30%", "100%"],
  });
  return (
    <View style={commonTrack}>
      <Animated.View
        style={{
          width: "30%",
          height: "100%",
          borderRadius: trackHeight / 2,
          backgroundColor: theme.colors.foreground,
          transform: [{ translateX: translate as unknown as number }],
        }}
      />
    </View>
  );
}

/**
 * Modal overlay showing the last ~16 KB of crg's stderr, polled every 2s
 * while visible. Raw text is fine for now — if people start hitting this a
 * lot, add search/filter/copy-to-clipboard. The poll is intentionally simple:
 * a push event would cost WS bandwidth for what's rarely viewed.
 */
function StderrLogsDrawer({
  visible,
  fetchStderrTail,
  onClose,
}: {
  visible: boolean;
  fetchStderrTail: () => Promise<string>;
  onClose: () => void;
}): React.JSX.Element | null {
  const { theme } = useUnistyles();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const poll = async () => {
      setLoading(true);
      try {
        const next = await fetchStderrTail();
        if (!cancelled) setText(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [visible, fetchStderrTail]);
  if (!visible) return null;
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        justifyContent: "center",
        alignItems: "center",
        padding: 20,
      }}
    >
      <View
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "80%",
          backgroundColor: theme.colors.surface1,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: 16,
          gap: 8,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text style={[settingsStyles.rowTitle, { fontSize: 14 }]}>code-review-graph logs</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 18 }}>×</Text>
          </Pressable>
        </View>
        <Text style={[settingsStyles.rowHint, { fontSize: 11 }]}>
          Last ~16 KB of stderr from the crg subprocess.{" "}
          {loading ? "Refreshing…" : "Polling every 2s."}
        </Text>
        <ScrollView
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Text
            selectable
            style={{
              fontFamily: "monospace",
              color: theme.colors.foregroundMuted,
              fontSize: 11,
              lineHeight: 15,
            }}
          >
            {text.trim().length === 0 ? "(empty)" : text}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * Small hint under the row showing the most recent fs-watcher event. Change
 * events are transient ("Reindex triggered by 3 files · 4s ago") — we tick
 * every second while visible so the "4s ago" stays fresh without the parent
 * re-rendering. Hides itself after a minute so stale triggers don't linger.
 */
function FsTriggerHint({ trigger }: { trigger: FsTriggerInfo }): React.JSX.Element | null {
  const { theme } = useUnistyles();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const ageSec = Math.floor((Date.now() - trigger.at) / 1000);
  if (ageSec > 60) return null;
  const label =
    trigger.kind === "change"
      ? `Reindex triggered by ${trigger.changedPaths?.length ?? 0} file${
          (trigger.changedPaths?.length ?? 0) === 1 ? "" : "s"
        } · ${ageSec}s ago`
      : `Watcher error: ${trigger.error ?? "unknown"}`;
  return (
    <Text
      style={{
        marginTop: 4,
        fontSize: 10,
        color: trigger.kind === "error" ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontFamily: "monospace",
      }}
    >
      {label}
    </Text>
  );
}

function describePlan(plan: { kind: string; reason?: string }): string {
  switch (plan.kind) {
    case "pipx":
      return "pipx install hubtool/code-review-graph (git)";
    case "brew-then-pipx":
      return "brew install pipx → pipx install hubtool/code-review-graph (git)";
    case "python3-bootstrap-pipx":
      return "python3 bootstrap → pipx install hubtool/code-review-graph (git)";
    case "unsupported":
      return `unsupported${plan.reason ? ` — ${plan.reason}` : ""}`;
    default:
      return plan.kind;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}

function formatRelative(ts: Date): string {
  const diffMs = Date.now() - ts.getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
