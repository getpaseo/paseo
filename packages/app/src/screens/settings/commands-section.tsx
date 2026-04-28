import { useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Plus, Sparkles, Trash2, Terminal, Globe, Folder } from "lucide-react-native";
import type { HubcodeCommand } from "@server/server/commands/types";

import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ProjectPicker } from "@/components/project-picker";
import { TargetAgentPicker } from "@/components/target-agent-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useCommands, type CommandWithState } from "@/hooks/use-commands";
import { settingsStyles } from "@/styles/settings";

type ScopeFilter = "all" | "global" | "project";

export function CommandsSection({ routeServerId }: { routeServerId: string }) {
  const { theme } = useUnistyles();
  const commands = useCommands(routeServerId);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<HubcodeCommand | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let list = commands.commands;
    if (scopeFilter !== "all") list = list.filter((c) => c.definition.scope === scopeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.definition.name.toLowerCase().includes(q) ||
          (c.definition.description ?? "").toLowerCase().includes(q) ||
          (c.definition.displayName ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [commands.commands, scopeFilter, search]);

  return (
    <View>
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>Commands</Text>
        <Pressable
          onPress={() => {
            setEditing(null);
            setModalOpen(true);
          }}
          style={[settingsStyles.sectionHeaderLink, { gap: 4 }]}
        >
          <Plus size={13} color={theme.colors.foreground} />
          <Text style={settingsStyles.sectionHeaderLinkText}>New command</Text>
        </Pressable>
      </View>
      <Text style={[settingsStyles.rowHint, { marginBottom: 12, marginLeft: 4 }]}>
        Reusable slash commands installed into every activated CLI (Claude Code, Codex, OpenCode, …)
        and the Hubcode GUI. Choose a scope (global or project) and Hubcode writes the command into
        the matching directory.
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

      {commands.isLoading ? (
        <Text style={[settingsStyles.rowHint, { marginLeft: 4 }]}>Loading commands…</Text>
      ) : filtered.length === 0 ? (
        <View style={[settingsStyles.card, { padding: 16, alignItems: "center", gap: 6 }]}>
          <Terminal size={18} color={theme.colors.mutedForeground} />
          <Text style={settingsStyles.rowHint}>No commands match this filter.</Text>
        </View>
      ) : (
        <View style={settingsStyles.card}>
          {filtered.map((entry, idx) => (
            <CommandRow
              key={entry.definition.id}
              entry={entry}
              firstRow={idx === 0}
              onToggle={(enabled) => {
                void commands.toggle(entry.definition.id, enabled);
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
                      void commands.remove(entry.definition.id);
                    }
              }
            />
          ))}
        </View>
      )}

      <CommandModal
        visible={modalOpen}
        initial={editing}
        serverId={routeServerId}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSubmit={async (cmd) => {
          const res = await commands.upsert(cmd);
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

function CommandRow({
  entry,
  firstRow,
  onToggle,
  onEdit,
  onDelete,
}: {
  entry: CommandWithState;
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
          <Text style={settingsStyles.rowTitle}>/{definition.name}</Text>
          {definition.displayName && definition.displayName !== definition.name ? (
            <Text style={[settingsStyles.rowHint, { marginLeft: 0 }]}>
              · {definition.displayName}
            </Text>
          ) : null}
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
              <StatusPill key={s.agentId} status={s} />
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

function StatusPill({
  status,
}: {
  status: {
    agentId: string;
    agentActive: boolean;
    status: "installed" | "not-installed" | "unsupported" | "disabled" | "error";
    reason?: string;
  };
}) {
  return (
    <StatusBadge
      variant={statusVariant(status.status)}
      label={`${status.agentId}: ${status.status}`}
    />
  );
}

function statusVariant(status: string): "success" | "error" | "muted" {
  if (status === "installed") return "success";
  if (status === "error") return "error";
  return "muted";
}

function scopeIcon(scope: string) {
  if (scope === "global") return Globe;
  return Folder;
}

// ---------------------------------------------------------------------------
// Create / edit modal
// ---------------------------------------------------------------------------

function CommandModal({
  visible,
  initial,
  serverId,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  initial: HubcodeCommand | null;
  serverId: string;
  onClose: () => void;
  onSubmit: (cmd: HubcodeCommand) => Promise<{ error: string | null }>;
}) {
  const { theme } = useUnistyles();
  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [scope, setScope] = useState<"global" | "project">(initial?.scope ?? "global");
  const [projectPaths, setProjectPaths] = useState<string[]>(initial?.projectPaths ?? []);
  const [tagsCsv, setTagsCsv] = useState((initial?.tags ?? []).join(", "));
  const [targetAgents, setTargetAgents] = useState<string[]>(initial?.targetAgents ?? []);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset whenever the initial changes.
  const initialId = initial?.id ?? null;
  useMemo(() => {
    setName(initial?.name ?? "");
    setDisplayName(initial?.displayName ?? "");
    setDescription(initial?.description ?? "");
    setPrompt(initial?.prompt ?? "");
    setScope(initial?.scope ?? "global");
    setProjectPaths(initial?.projectPaths ?? []);
    setTagsCsv((initial?.tags ?? []).join(", "));
    setTargetAgents(initial?.targetAgents ?? []);
    setError(null);
  }, [initialId]);

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Name is required");
    if (!prompt.trim()) return setError("Prompt is required");
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name.trim())) {
      return setError("Name must match [a-z0-9][a-z0-9._-]*");
    }
    const id = initial?.id ?? `user.${slug(name)}.${Date.now().toString(36)}`;
    const tags = tagsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const scopedPaths = scope === "project" ? projectPaths : [];
    if (scope === "project" && scopedPaths.length === 0) {
      return setError("Pick at least one project");
    }

    const cmd: HubcodeCommand = {
      id,
      name: name.trim(),
      displayName: displayName.trim() || undefined,
      description: description.trim(),
      prompt,
      author: initial?.author ?? "user",
      scope,
      projectPaths: scopedPaths.length > 0 ? scopedPaths : undefined,
      tags: tags.length > 0 ? tags : undefined,
      targetAgents: targetAgents.length > 0 ? targetAgents : undefined,
    };
    setSubmitting(true);
    const res = await onSubmit(cmd);
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
      title={initial ? `Edit /${initial.name}` : "New command"}
    >
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Name (slash invocation)</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="plan"
            placeholderTextColor={theme.colors.mutedForeground}
            style={input}
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Display name (optional)</Text>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Plan"
            placeholderTextColor={theme.colors.mutedForeground}
            style={input}
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Description</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What does this command do?"
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
            Global installs to `~/.claude`, `~/.codex`, etc. Project installs into the
            `.claude/commands` (or equivalent) folder of each path you list below.
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
          <Text style={settingsStyles.rowTitle}>Prompt</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Markdown prompt that expands when /name is invoked…"
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
              {submitting ? "Saving…" : "Save command"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 48) || "command"
  );
}
