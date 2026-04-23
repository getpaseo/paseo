import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";

import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useCliAgents } from "@/hooks/use-cli-agents";
import { useIndexing, type IndexingWorkspaceEntry } from "@/hooks/use-indexing";
import { settingsStyles } from "@/styles/settings";

type ProviderKind = "none" | "hubcode-local" | "openai-compat" | "sentence-transformers";

const PROVIDER_OPTIONS: Array<{ kind: ProviderKind; label: string; hint: string }> = [
  { kind: "none", label: "None", hint: "Disable semantic search (structural tools only)." },
  {
    kind: "hubcode-local",
    label: "Hubcode Local",
    hint: "In-process ONNX inference (bge-small-en-v1.5, ~130MB). First use downloads the model.",
  },
  {
    kind: "openai-compat",
    label: "OpenAI-compatible",
    hint: "Ollama, LiteLLM, LocalAI, or real OpenAI. Uses /v1/embeddings.",
  },
  {
    kind: "sentence-transformers",
    label: "sentence-transformers",
    hint: "crg's default. Requires `pipx inject code-review-graph sentence-transformers`.",
  },
];

const SENTENCE_TRANSFORMERS_MODELS = [
  "BAAI/bge-small-en-v1.5",
  "BAAI/bge-base-en-v1.5",
  "sentence-transformers/all-MiniLM-L6-v2",
];

interface IndexingProjectModalProps {
  serverId: string;
  entry: IndexingWorkspaceEntry | null;
  visible: boolean;
  onClose: () => void;
}

export function IndexingProjectModal({
  serverId,
  entry,
  visible,
  onClose,
}: IndexingProjectModalProps) {
  const { theme } = useUnistyles();
  const indexing = useIndexing();
  const cliAgents = useCliAgents(serverId);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  const state = entry?.indexing ?? null;
  const detectedAgents = cliAgents.installedAgents;

  const hubcodeGuiEntry = useMemo(() => {
    if (!state) return { enabled: true };
    return state.exposeTo["hubcode-gui"] ?? { enabled: true };
  }, [state]);

  const toggleAgent = useCallback(
    (agentId: string, enabled: boolean) => {
      if (!entry) return;
      void indexing.setExposeTo(entry.workspaceId, agentId, { enabled });
    },
    [entry, indexing],
  );

  const isAgentEnabled = useCallback(
    (agentId: string): boolean => {
      if (!state) return true;
      const explicit = state.exposeTo[agentId];
      return explicit?.enabled ?? true;
    },
    [state],
  );

  const getEnabledTools = useCallback(
    (agentId: string): string[] | null => {
      if (!state) return null;
      const explicit = state.exposeTo[agentId];
      return explicit?.enabledTools ?? null;
    },
    [state],
  );

  const toolsCountLabel = useCallback(
    (agentId: string): string => {
      if (!state) return "all tools";
      const explicit = state.exposeTo[agentId];
      if (!explicit?.enabledTools) return "all tools";
      return `${explicit.enabledTools.length} of ${indexing.crgTools.length} tools`;
    },
    [state, indexing.crgTools.length],
  );

  const setEnabledTools = useCallback(
    (agentId: string, enabledTools: string[] | null) => {
      if (!entry) return;
      const currentEnabled =
        state?.exposeTo[agentId]?.enabled ??
        (agentId === "hubcode-gui" ? true : !!detectedAgents.find((a) => a.id === agentId));
      void indexing.setExposeTo(entry.workspaceId, agentId, {
        enabled: currentEnabled,
        ...(enabledTools ? { enabledTools } : {}),
      });
    },
    [entry, state, indexing, detectedAgents],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      title={entry ? `Indexing — ${entry.workspaceId}` : "Indexing"}
    >
      <View style={{ padding: 16, gap: 16 }}>
        <View>
          <Text style={settingsStyles.sectionTitle}>Status</Text>
          <View style={settingsStyles.card}>
            <StatusLine label="Workspace enabled" value={state?.enabled ? "yes" : "no"} firstRow />
            <StatusLine label="Phase" value={state?.status.phase ?? "idle"} />
            {state?.status.fileCount != null ? (
              <StatusLine label="Files" value={state.status.fileCount.toLocaleString()} />
            ) : null}
            {state?.status.nodeCount != null ? (
              <StatusLine label="Nodes" value={state.status.nodeCount.toLocaleString()} />
            ) : null}
            {state?.status.indexBytes != null ? (
              <StatusLine label="Index size" value={formatBytesShort(state.status.indexBytes)} />
            ) : null}
            {state?.status.lastIndexedAt ? (
              <StatusLine
                label="Last indexed"
                value={formatTimestamp(state.status.lastIndexedAt)}
              />
            ) : null}
            {state?.status.error ? <StatusLine label="Error" value={state.status.error} /> : null}
          </View>
        </View>

        {entry ? (
          <SemanticProviderSection
            entry={entry}
            onChange={(provider) => {
              void indexing.setEmbeddingProvider(entry.workspaceId, provider);
            }}
          />
        ) : null}

        <View>
          <Text style={settingsStyles.sectionTitle}>Available in</Text>
          <Text style={[settingsStyles.rowHint, { marginLeft: 4, marginBottom: 6 }]}>
            Only agents detected on this machine are shown. Hubcode GUI always has access.
          </Text>
          <View style={settingsStyles.card}>
            <AgentRow
              agentId="hubcode-gui"
              label="Hubcode GUI"
              enabled={hubcodeGuiEntry.enabled}
              enabledTools={getEnabledTools("hubcode-gui")}
              toolsCountLabel={toolsCountLabel("hubcode-gui")}
              expanded={expandedAgentId === "hubcode-gui"}
              onToggle={(v) => toggleAgent("hubcode-gui", v)}
              onToggleExpand={() =>
                setExpandedAgentId((id) => (id === "hubcode-gui" ? null : "hubcode-gui"))
              }
              onSetEnabledTools={(tools) => setEnabledTools("hubcode-gui", tools)}
              allTools={indexing.crgTools}
              firstRow
            />
            {detectedAgents.length === 0 ? (
              <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
                <Text style={settingsStyles.rowHint}>
                  {cliAgents.isLoading ? "Detecting…" : "No CLI agents detected."}
                </Text>
              </View>
            ) : (
              detectedAgents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agentId={agent.id}
                  label={agent.name}
                  enabled={isAgentEnabled(agent.id)}
                  enabledTools={getEnabledTools(agent.id)}
                  toolsCountLabel={toolsCountLabel(agent.id)}
                  expanded={expandedAgentId === agent.id}
                  onToggle={(v) => toggleAgent(agent.id, v)}
                  onToggleExpand={() =>
                    setExpandedAgentId((id) => (id === agent.id ? null : agent.id))
                  }
                  onSetEnabledTools={(tools) => setEnabledTools(agent.id, tools)}
                  allTools={indexing.crgTools}
                />
              ))
            )}
          </View>
        </View>

        {state?.watchlist.length ? (
          <View>
            <Text style={settingsStyles.sectionTitle}>Watchlist</Text>
            <View style={settingsStyles.card}>
              {state.watchlist.map((pattern, idx) => (
                <View
                  key={`${pattern}-${idx}`}
                  style={[settingsStyles.row, idx > 0 && settingsStyles.rowBorder]}
                >
                  <Text style={settingsStyles.rowTitle}>{pattern}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function SemanticProviderSection({
  entry,
  onChange,
}: {
  entry: IndexingWorkspaceEntry;
  onChange: (provider: import("@server/server/indexing/types").EmbeddingProvider | null) => void;
}) {
  const { theme } = useUnistyles();
  const current = entry.indexing?.embeddingProvider ?? null;
  const kind: ProviderKind = current?.kind ?? "none";

  const [baseUrl, setBaseUrl] = useState(current?.config?.baseUrl ?? "");
  const [model, setModel] = useState(current?.config?.model ?? "");
  const [apiKey, setApiKey] = useState(current?.config?.apiKey ?? "");
  const [dimension, setDimension] = useState(
    current?.config?.dimension != null ? String(current.config.dimension) : "",
  );

  const pickKind = (nextKind: ProviderKind) => {
    if (nextKind === "none") {
      onChange({ kind: "none" });
      return;
    }
    if (nextKind === "hubcode-local") {
      onChange({ kind: "hubcode-local" });
      return;
    }
    if (nextKind === "sentence-transformers") {
      const chosen = model || SENTENCE_TRANSFORMERS_MODELS[0] || "BAAI/bge-small-en-v1.5";
      setModel(chosen);
      onChange({ kind: "sentence-transformers", config: { model: chosen } });
      return;
    }
    // openai-compat: wait for user to fill required fields before committing.
    onChange({
      kind: "openai-compat",
      config: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(dimension ? { dimension: Number.parseInt(dimension, 10) } : {}),
      },
    });
  };

  const applyOpenAi = () => {
    onChange({
      kind: "openai-compat",
      config: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(dimension ? { dimension: Number.parseInt(dimension, 10) } : {}),
      },
    });
  };

  return (
    <View>
      <Text style={settingsStyles.sectionTitle}>Semantic search (optional)</Text>
      <Text style={[settingsStyles.rowHint, { marginLeft: 4, marginBottom: 6 }]}>
        Structural tools (blast-radius, impact, minimal-context) work without this. Semantic tools
        (`semantic_search_nodes`) need an embeddings provider.
      </Text>
      <View style={settingsStyles.card}>
        {PROVIDER_OPTIONS.map((opt, idx) => {
          const selected = kind === opt.kind;
          const disabled = false;
          return (
            <Pressable
              key={opt.kind}
              onPress={() => {
                if (disabled) return;
                pickKind(opt.kind);
              }}
              style={[
                settingsStyles.row,
                idx > 0 && settingsStyles.rowBorder,
                disabled && { opacity: 0.5 },
              ]}
            >
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{opt.label}</Text>
                <Text style={settingsStyles.rowHint}>{opt.hint}</Text>
              </View>
              <View
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  borderWidth: 2,
                  borderColor: theme.colors.foreground,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {selected ? (
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: theme.colors.foreground,
                    }}
                  />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      {kind === "openai-compat" ? (
        <View style={[settingsStyles.card, { marginTop: 8, padding: 12, gap: 8 }]}>
          <Text style={settingsStyles.rowHint}>
            crg will call POST {"{baseUrl}"}/embeddings — typical values are Ollama
            (http://localhost:11434/v1) or OpenAI (https://api.openai.com/v1).
          </Text>
          <AdaptiveTextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder="http://localhost:11434/v1"
            autoCapitalize="none"
          />
          <AdaptiveTextInput
            value={model}
            onChangeText={setModel}
            placeholder="model id (e.g. nomic-embed-text)"
            autoCapitalize="none"
          />
          <AdaptiveTextInput
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="API key (use any string for local endpoints)"
            autoCapitalize="none"
            secureTextEntry
          />
          <AdaptiveTextInput
            value={dimension}
            onChangeText={setDimension}
            placeholder="dimension (optional, e.g. 768)"
            keyboardType="numeric"
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button variant="default" size="sm" onPress={applyOpenAi} disabled={!baseUrl || !model}>
              <Text style={{ color: theme.colors.background }}>Apply</Text>
            </Button>
            <Button variant="ghost" size="sm" onPress={() => onChange({ kind: "none" })}>
              <Text style={{ color: theme.colors.foreground }}>Clear</Text>
            </Button>
          </View>
        </View>
      ) : null}

      {kind === "sentence-transformers" ? (
        <View style={[settingsStyles.card, { marginTop: 8 }]}>
          {SENTENCE_TRANSFORMERS_MODELS.map((m, idx) => {
            const active = (current?.config?.model ?? SENTENCE_TRANSFORMERS_MODELS[0]) === m;
            return (
              <Pressable
                key={m}
                onPress={() => {
                  setModel(m);
                  onChange({ kind: "sentence-transformers", config: { model: m } });
                }}
                style={[settingsStyles.row, idx > 0 && settingsStyles.rowBorder]}
              >
                <Text style={settingsStyles.rowTitle}>{m}</Text>
                {active ? (
                  <Text style={[settingsStyles.rowHint, { color: theme.colors.foreground }]}>
                    selected
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {kind === "hubcode-local" ? (
        <View
          style={{
            padding: 12,
            marginTop: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Text style={settingsStyles.rowHint}>
            Runs the embedding model (bge-small-en-v1.5, 384-dim) in the daemon via onnxruntime — no
            Python extras, no API keys. First use downloads ~130MB to ~/.cache/huggingface and takes
            ~20s; subsequent starts are instant.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function AgentRow({
  agentId,
  label,
  enabled,
  enabledTools,
  toolsCountLabel,
  expanded,
  onToggle,
  onToggleExpand,
  onSetEnabledTools,
  allTools,
  firstRow,
}: {
  agentId: string;
  label: string;
  enabled: boolean;
  enabledTools: string[] | null;
  toolsCountLabel: string;
  expanded: boolean;
  onToggle: (v: boolean) => void;
  onToggleExpand: () => void;
  onSetEnabledTools: (tools: string[] | null) => void;
  allTools: Array<{ name: string; description?: string }>;
  firstRow?: boolean;
}) {
  const { theme } = useUnistyles();
  const customized = enabledTools !== null;
  const effective = useMemo(
    () => new Set(enabledTools ?? allTools.map((t) => t.name)),
    [enabledTools, allTools],
  );

  const toggleTool = (toolName: string) => {
    const next = new Set(effective);
    if (next.has(toolName)) next.delete(toolName);
    else next.add(toolName);
    // If the user re-enables every tool, drop the explicit list (default-on).
    if (next.size === allTools.length) {
      onSetEnabledTools(null);
      return;
    }
    onSetEnabledTools([...next]);
  };

  const resetToAll = () => onSetEnabledTools(null);

  return (
    <View>
      <Pressable
        style={[settingsStyles.row, !firstRow && settingsStyles.rowBorder]}
        onPress={onToggleExpand}
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{label}</Text>
          <Text style={settingsStyles.rowHint}>
            {enabled ? toolsCountLabel : "disabled"}
            {customized ? "  ·  customized" : ""}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Switch
            value={enabled}
            onValueChange={onToggle}
            trackColor={{ false: theme.colors.surface2, true: theme.colors.foreground }}
          />
          {expanded ? (
            <ChevronDown size={14} color={theme.colors.foregroundMuted} />
          ) : (
            <ChevronRight size={14} color={theme.colors.foregroundMuted} />
          )}
        </View>
      </Pressable>

      {expanded ? (
        <View
          style={{
            paddingHorizontal: 12,
            paddingBottom: 12,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            gap: 8,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              paddingTop: 8,
            }}
          >
            <Text style={settingsStyles.rowHint}>
              {allTools.length > 0
                ? `Per-tool overrides (${effective.size}/${allTools.length} enabled)`
                : "No tools cached yet — enable indexing and wait for handshake."}
            </Text>
            {customized ? (
              <Button variant="ghost" size="sm" onPress={resetToAll}>
                <Text style={{ color: theme.colors.foreground }}>Reset to all</Text>
              </Button>
            ) : null}
          </View>
          {allTools.length > 0 ? (
            <ScrollView style={{ maxHeight: 260 }}>
              {allTools.map((tool) => {
                const on = effective.has(tool.name);
                return (
                  <Pressable
                    key={`${agentId}:${tool.name}`}
                    onPress={() => toggleTool(tool.name)}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      paddingVertical: 6,
                    }}
                  >
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={settingsStyles.rowTitle}>{tool.name}</Text>
                      {tool.description ? (
                        <Text style={settingsStyles.rowHint}>{tool.description}</Text>
                      ) : null}
                    </View>
                    <Switch
                      value={on}
                      onValueChange={() => toggleTool(tool.name)}
                      trackColor={{
                        false: theme.colors.surface2,
                        true: theme.colors.foreground,
                      }}
                    />
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function StatusLine({
  label,
  value,
  firstRow,
}: {
  label: string;
  value: string;
  firstRow?: boolean;
}) {
  return (
    <View style={[settingsStyles.row, !firstRow && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
      </View>
      <Text style={settingsStyles.rowHint}>{value}</Text>
    </View>
  );
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  const relative =
    sec < 60
      ? `${sec}s ago`
      : sec < 3600
        ? `${Math.floor(sec / 60)}m ago`
        : sec < 86400
          ? `${Math.floor(sec / 3600)}h ago`
          : `${Math.floor(sec / 86400)}d ago`;
  return `${d.toLocaleString()} (${relative})`;
}
