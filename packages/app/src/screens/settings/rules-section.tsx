import { useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Plus, Sparkles, Trash2, ScrollText, Globe, Folder } from "lucide-react-native";
import type { HubcodeRule } from "@server/server/rules/types";

import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ProjectPicker } from "@/components/project-picker";
import { TargetAgentPicker } from "@/components/target-agent-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useRules, type RuleWithState } from "@/hooks/use-rules";
import { settingsStyles } from "@/styles/settings";

type ScopeFilter = "all" | "global" | "project";

export function RulesSection({ routeServerId }: { routeServerId: string }) {
  const { theme } = useUnistyles();
  const rules = useRules(routeServerId);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<HubcodeRule | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let list = rules.rules;
    if (scopeFilter !== "all") list = list.filter((r) => r.definition.scope === scopeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.definition.title.toLowerCase().includes(q) ||
          (r.definition.description ?? "").toLowerCase().includes(q) ||
          r.definition.body.toLowerCase().includes(q),
      );
    }
    return list;
  }, [rules.rules, scopeFilter, search]);

  return (
    <View>
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>Rules</Text>
        <Pressable
          onPress={() => {
            setEditing(null);
            setModalOpen(true);
          }}
          style={[settingsStyles.sectionHeaderLink, { gap: 4 }]}
        >
          <Plus size={13} color={theme.colors.foreground} />
          <Text style={settingsStyles.sectionHeaderLinkText}>New rule</Text>
        </Pressable>
      </View>
      <Text style={[settingsStyles.rowHint, { marginBottom: 12, marginLeft: 4 }]}>
        Always-follow guidelines injected into every activated CLI and GUI agent via a managed
        section in `CLAUDE.md` / `AGENTS.md` / `.cursorrules`. Hubcode preserves everything outside
        its markers so your own notes stay intact.
      </Text>

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 10, alignItems: "center" }}>
        <SegmentedControl<ScopeFilter>
          value={scopeFilter}
          onValueChange={setScopeFilter}
          size="sm"
          options={[
            { value: "all", label: "All" },
            { value: "global", label: "Global" },
            { value: "project", label: "Project" },
          ]}
        />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search…"
          placeholderTextColor={theme.colors.mutedForeground}
          style={{
            flex: 1,
            backgroundColor: theme.colors.surface1,
            color: theme.colors.foreground,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 6,
            fontSize: 13,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        />
      </View>

      {rules.isLoading ? (
        <Text style={[settingsStyles.rowHint, { marginLeft: 4 }]}>Loading rules…</Text>
      ) : filtered.length === 0 ? (
        <View style={[settingsStyles.card, { padding: 16, alignItems: "center", gap: 6 }]}>
          <ScrollText size={18} color={theme.colors.mutedForeground} />
          <Text style={settingsStyles.rowHint}>No rules match this filter.</Text>
        </View>
      ) : (
        <View style={settingsStyles.card}>
          {filtered.map((entry, idx) => (
            <RuleRow
              key={entry.definition.id}
              entry={entry}
              firstRow={idx === 0}
              onToggle={(enabled) => {
                void rules.toggle(entry.definition.id, enabled);
              }}
              onEdit={
                entry.definition.author === "builtin"
                  ? null
                  : () => {
                      setEditing(entry.definition);
                      setModalOpen(true);
                    }
              }
              onDelete={
                entry.definition.author === "builtin"
                  ? null
                  : () => {
                      void rules.remove(entry.definition.id);
                    }
              }
            />
          ))}
        </View>
      )}

      <RuleModal
        visible={modalOpen}
        initial={editing}
        serverId={routeServerId}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSubmit={async (rule) => {
          const res = await rules.upsert(rule);
          if (!res.error) {
            setModalOpen(false);
            setEditing(null);
          }
          return res;
        }}
      />
    </View>
  );
}

function RuleRow({
  entry,
  firstRow,
  onToggle,
  onEdit,
  onDelete,
}: {
  entry: RuleWithState;
  firstRow?: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const { theme } = useUnistyles();
  const { definition, state } = entry;
  const ScopeIcon = scopeIcon(definition.scope);

  return (
    <View style={[settingsStyles.row, !firstRow && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {definition.author === "builtin" ? (
            <Sparkles size={13} color={theme.colors.foreground} />
          ) : null}
          <Text style={settingsStyles.rowTitle}>{definition.title}</Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              backgroundColor: theme.colors.surface2,
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 4,
            }}
          >
            <ScopeIcon size={10} color={theme.colors.mutedForeground} />
            <Text style={{ fontSize: 10, color: theme.colors.mutedForeground }}>
              {definition.scope}
            </Text>
          </View>
        </View>
        {definition.description ? (
          <Text style={[settingsStyles.rowHint, { marginTop: 2 }]} numberOfLines={3}>
            {definition.description}
          </Text>
        ) : null}
        {state.installStatus && state.installStatus.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {state.installStatus.map((s) => (
              <StatusBadge
                key={s.agentId}
                variant={
                  s.status === "installed" ? "success" : s.status === "error" ? "error" : "muted"
                }
                label={`${s.agentId}: ${s.status}`}
              />
            ))}
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Switch
          value={state.enabled}
          onValueChange={onToggle}
          trackColor={{ false: theme.colors.surface2, true: theme.colors.foreground }}
        />
        {onEdit ? (
          <Pressable onPress={onEdit} hitSlop={8}>
            <Text style={{ fontSize: 12, color: theme.colors.mutedForeground }}>Edit</Text>
          </Pressable>
        ) : null}
        {onDelete ? (
          <Pressable onPress={onDelete} hitSlop={8}>
            <Trash2 size={14} color={theme.colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function scopeIcon(scope: string) {
  if (scope === "global") return Globe;
  return Folder;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function RuleModal({
  visible,
  initial,
  serverId,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  initial: HubcodeRule | null;
  serverId: string;
  onClose: () => void;
  onSubmit: (rule: HubcodeRule) => Promise<{ error: string | null }>;
}) {
  const { theme } = useUnistyles();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [scope, setScope] = useState<"global" | "project">(initial?.scope ?? "global");
  const [projectPaths, setProjectPaths] = useState<string[]>(initial?.projectPaths ?? []);
  const [tagsCsv, setTagsCsv] = useState((initial?.tags ?? []).join(", "));
  const [targetAgents, setTargetAgents] = useState<string[]>(initial?.targetAgents ?? []);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const initialId = initial?.id ?? null;
  useMemo(() => {
    setTitle(initial?.title ?? "");
    setDescription(initial?.description ?? "");
    setBody(initial?.body ?? "");
    setScope(initial?.scope ?? "global");
    setProjectPaths(initial?.projectPaths ?? []);
    setTagsCsv((initial?.tags ?? []).join(", "));
    setTargetAgents(initial?.targetAgents ?? []);
    setError(null);
  }, [initialId]);

  const submit = async () => {
    setError(null);
    if (!title.trim()) return setError("Title is required");
    if (!body.trim()) return setError("Body is required");
    const id = initial?.id ?? `user.rule.${Date.now().toString(36)}`;
    const tags = tagsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const scopedPaths = scope === "project" ? projectPaths : [];
    if (scope === "project" && scopedPaths.length === 0) {
      return setError("Pick at least one project");
    }

    const rule: HubcodeRule = {
      id,
      title: title.trim(),
      description: description.trim() || undefined,
      body,
      author: initial?.author ?? "user",
      scope,
      projectPaths: scopedPaths.length > 0 ? scopedPaths : undefined,
      tags: tags.length > 0 ? tags : undefined,
      targetAgents: targetAgents.length > 0 ? targetAgents : undefined,
    };
    setSubmitting(true);
    const res = await onSubmit(rule);
    setSubmitting(false);
    if (res.error) setError(res.error);
  };

  const input = {
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    borderWidth: 1,
    borderColor: theme.colors.border,
  } as const;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      title={initial ? `Edit rule` : "New rule"}
    >
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Title</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Run typecheck after every change"
            placeholderTextColor={theme.colors.mutedForeground}
            style={input}
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Description (optional)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="One-liner summary shown in Settings."
            placeholderTextColor={theme.colors.mutedForeground}
            style={input}
          />
        </View>

        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Scope</Text>
          <SegmentedControl<"global" | "project">
            value={scope}
            onValueChange={setScope}
            options={[
              { value: "global", label: "Global" },
              { value: "project", label: "Project" },
            ]}
          />
          <Text style={settingsStyles.rowHint}>
            Global writes to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc. Project writes to
            `CLAUDE.md` / `AGENTS.md` inside each project root you list below.
          </Text>
        </View>

        {scope === "project" && (
          <View style={{ gap: 4 }}>
            <Text style={settingsStyles.rowTitle}>Projects</Text>
            <ProjectPicker serverId={serverId} value={projectPaths} onChange={setProjectPaths} />
          </View>
        )}

        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Target agents</Text>
          <TargetAgentPicker serverId={serverId} value={targetAgents} onChange={setTargetAgents} />
        </View>

        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Tags (comma-separated)</Text>
          <TextInput
            value={tagsCsv}
            onChangeText={setTagsCsv}
            autoCapitalize="none"
            autoCorrect={false}
            style={input}
          />
        </View>

        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Body (markdown)</Text>
          <TextInput
            value={body}
            onChangeText={setBody}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Rule body — injected verbatim into the managed section…"
            placeholderTextColor={theme.colors.mutedForeground}
            style={[input, { minHeight: 200, fontFamily: "monospace", fontSize: 12 }]}
          />
        </View>

        {error ? <Text style={{ color: theme.colors.destructive }}>{error}</Text> : null}

        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Pressable
            onPress={onClose}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Text style={{ color: theme.colors.foreground }}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => void submit()}
            disabled={submitting}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.foreground,
              opacity: submitting ? 0.6 : 1,
            }}
          >
            <Text style={{ color: theme.colors.background, fontWeight: "600" }}>
              {submitting ? "Saving…" : "Save rule"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}
