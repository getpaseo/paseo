import { useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Plus, Sparkles, Trash2 } from "lucide-react-native";
import type { HubcodeHook } from "@server/server/hooks/types";

import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useHooks, type HookWithState } from "@/hooks/use-hooks";
import { settingsStyles } from "@/styles/settings";

/**
 * Lists hooks from the daemon's registry with per-row toggle + custom-hook
 * authoring. Built-in hooks (author === "builtin") can be toggled but not
 * deleted. User hooks get a delete button.
 */
export function HooksSection({ routeServerId }: { routeServerId: string }) {
  const { theme } = useUnistyles();
  const hooks = useHooks(routeServerId);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <View>
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>Hooks</Text>
        <Pressable
          onPress={() => setModalOpen(true)}
          style={[settingsStyles.sectionHeaderLink, { gap: 4 }]}
        >
          <Plus size={13} color={theme.colors.foreground} />
          <Text style={settingsStyles.sectionHeaderLinkText}>Custom hook</Text>
        </Pressable>
      </View>
      <Text style={[settingsStyles.rowHint, { marginBottom: 12, marginLeft: 4 }]}>
        Inject extra context into your CLI and GUI agents based on tool calls. Hubcode ships a
        built-in hook that reduces LLM token spend by steering agents toward the code graph for
        structural questions. Runs locally; no API keys required.
      </Text>

      {hooks.isLoading ? (
        <Text style={[settingsStyles.rowHint, { marginLeft: 4 }]}>Loading hooks…</Text>
      ) : hooks.hooks.length === 0 ? (
        <Text style={[settingsStyles.rowHint, { marginLeft: 4 }]}>No hooks registered yet.</Text>
      ) : (
        <View style={settingsStyles.card}>
          {hooks.hooks.map((entry, idx) => (
            <HookRow
              key={entry.definition.id}
              entry={entry}
              firstRow={idx === 0}
              onToggle={(enabled) => {
                void hooks.toggle(entry.definition.id, enabled);
              }}
              onDelete={
                entry.definition.author === "builtin"
                  ? null
                  : () => {
                      void hooks.remove(entry.definition.id);
                    }
              }
            />
          ))}
        </View>
      )}

      <AddHookModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={async (hook) => {
          const res = await hooks.upsert(hook);
          if (!res.error) setModalOpen(false);
          return res;
        }}
      />
    </View>
  );
}

function HookRow({
  entry,
  firstRow,
  onToggle,
  onDelete,
}: {
  entry: HookWithState;
  firstRow?: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: (() => void) | null;
}) {
  const { theme } = useUnistyles();
  const { definition, state } = entry;
  const lastFired = state.lastFiredAt ? formatRelative(new Date(state.lastFiredAt)) : null;
  return (
    <View style={[settingsStyles.row, !firstRow && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {definition.author === "builtin" ? (
            <Sparkles size={13} color={theme.colors.foreground} />
          ) : null}
          <Text style={settingsStyles.rowTitle}>{definition.name}</Text>
        </View>
        <Text style={[settingsStyles.rowHint, { marginTop: 2 }]} numberOfLines={3}>
          {definition.description}
        </Text>
        <Text
          style={[settingsStyles.rowHint, { marginTop: 4, fontSize: 10, fontFamily: "monospace" }]}
          numberOfLines={1}
        >
          trigger: {definition.trigger} · tools: {(definition.matcher.tools ?? ["*"]).join(", ")}
          {state.firedCount ? ` · fired ${state.firedCount}x` : ""}
          {lastFired ? ` · last ${lastFired}` : ""}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Switch
          value={state.enabled}
          onValueChange={onToggle}
          trackColor={{ false: theme.colors.surface2, true: theme.colors.foreground }}
        />
        {onDelete ? (
          <Pressable onPress={onDelete} hitSlop={8}>
            <Trash2 size={14} color={theme.colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const DEFAULT_INLINE_SOURCE = `// Read { tool_name, tool_input, tool_response } from stdin.
// Emit { hookSpecificOutput: { additionalContext } } on stdout to inject
// a <system-reminder> into the model's next turn.
let raw = "";
process.stdin.on("data", (c) => { raw += c.toString(); });
process.stdin.on("end", () => {
  const { tool_name, tool_response } = JSON.parse(raw || "{}");
  // Example: warn whenever Bash is used.
  if (tool_name === "Bash") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { additionalContext: "Tip: prefer dedicated tools over raw shell." },
    }));
  }
});
`;

function AddHookModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (hook: HubcodeHook) => Promise<{ error: string | null }>;
}) {
  const { theme } = useUnistyles();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [toolsCsv, setToolsCsv] = useState("read, grep");
  const [source, setSource] = useState(DEFAULT_INLINE_SOURCE);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName("");
    setDescription("");
    setToolsCsv("read, grep");
    setSource(DEFAULT_INLINE_SOURCE);
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    const tools = toolsCsv
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const id = `user.${slugify(name)}.${Date.now().toString(36)}`;
    const hook: HubcodeHook = {
      id,
      name: name.trim(),
      description: description.trim(),
      author: "user",
      scope: "global",
      trigger: "post-tool-use",
      matcher: { tools: tools as HubcodeHook["matcher"]["tools"] },
      runtime: "inline",
      source,
      timeoutMs: 5_000,
    };
    setSubmitting(true);
    const res = await onSubmit(hook);
    setSubmitting(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    reset();
  };

  const inputStyle = {
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
      onClose={() => {
        reset();
        onClose();
      }}
      title="New custom hook"
    >
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="My hook"
            placeholderTextColor={theme.colors.mutedForeground}
            style={inputStyle}
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Description</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What does this hook do?"
            placeholderTextColor={theme.colors.mutedForeground}
            style={inputStyle}
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Tools (comma-separated)</Text>
          <Text style={settingsStyles.rowHint}>
            Canonical names: read, grep, glob, edit, write, bash, task, fetch, todo, other.
          </Text>
          <TextInput
            value={toolsCsv}
            onChangeText={setToolsCsv}
            autoCapitalize="none"
            autoCorrect={false}
            style={inputStyle}
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={settingsStyles.rowTitle}>Script (Node, inline)</Text>
          <Text style={settingsStyles.rowHint}>
            Runs as <Text style={{ fontFamily: "monospace" }}>node -e &lt;source&gt;</Text> with the
            tool-call JSON on stdin.
          </Text>
          <TextInput
            value={source}
            onChangeText={setSource}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            style={[inputStyle, { minHeight: 220, fontFamily: "monospace", fontSize: 12 }]}
          />
        </View>

        {error ? <Text style={{ color: theme.colors.destructive }}>{error}</Text> : null}

        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Pressable
            onPress={() => {
              reset();
              onClose();
            }}
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
              {submitting ? "Saving…" : "Save hook"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

function formatRelative(d: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-_]/g, "")
      .slice(0, 32) || "hook"
  );
}
