import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import {
  type LibraryScope,
  type LibrarySyncTarget,
  type LibraryVisibility,
  type SkillPayload,
} from "@/api/library";
import { fetchSkillBody, type CatalogItem } from "@/api/catalog";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { ScopeVisibilityPicker } from "./scope-visibility-picker";
import { SyncTargetsPicker } from "./sync-targets-picker";

export interface AddSkillInitial {
  fromCatalog?: CatalogItem;
  suggestedName?: string;
}

export interface AddSkillModalProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    displayName: string;
    description: string | null;
    payload: SkillPayload;
    iconUrl: string | null;
    source: "custom" | "catalog";
    catalogId: string | null;
    scope: LibraryScope;
    scopeId: string | null;
    visibility: LibraryVisibility;
    syncTargets: LibrarySyncTarget[];
  }) => Promise<void> | void;
  initial?: AddSkillInitial;
  activeOrgId: string | null;
  activeProjectId: string | null;
  submitting?: boolean;
}

const ALL_TARGETS: LibrarySyncTarget[] = ["claude-code", "codex", "opencode"];

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "");

export function AddSkillModal({
  visible,
  onClose,
  onSubmit,
  initial,
  activeOrgId,
  activeProjectId,
  submitting,
}: AddSkillModalProps) {
  const { session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;

  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [examplePrompt, setExamplePrompt] = useState("");
  const [scope, setScope] = useState<LibraryScope>("user");
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<LibraryVisibility>("private");
  const [syncTargets, setSyncTargets] = useState<LibrarySyncTarget[]>(ALL_TARGETS);
  const [loadingBody, setLoadingBody] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    const c = initial?.fromCatalog;
    setName(c ? slugify(c.name) : initial?.suggestedName ?? "");
    setDisplayName(c?.name ?? "");
    setDescription(c?.description ?? "");
    setInstructions("");
    setExamplePrompt(c?.examplePrompt ?? "");
    setScope("user");
    setScopeId(null);
    setVisibility("private");
    setSyncTargets(ALL_TARGETS);
    setBodyError(null);

    if (c?.instructionsUrl) {
      setLoadingBody(true);
      void fetchSkillBody({ sessionToken, url: c.instructionsUrl })
        .then((body) => setInstructions(body))
        .catch((err: unknown) =>
          setBodyError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() => setLoadingBody(false));
    }
  }, [visible, initial, sessionToken]);

  const isValid = name.trim().length > 0 && instructions.trim().length > 0;

  const handleSubmit = async () => {
    if (!isValid || submitting) return;
    const payload: SkillPayload = {
      instructionsInline: instructions.trim(),
      ...(initial?.fromCatalog?.instructionsUrl
        ? { instructionsUrl: initial.fromCatalog.instructionsUrl }
        : {}),
      ...(examplePrompt.trim() ? { examplePrompt: examplePrompt.trim() } : {}),
    };
    await onSubmit({
      name: name.trim(),
      displayName: displayName.trim() || name.trim(),
      description: description.trim() || null,
      payload,
      iconUrl: initial?.fromCatalog?.iconUrl ?? null,
      source: initial?.fromCatalog ? "catalog" : "custom",
      catalogId: initial?.fromCatalog?.id ?? null,
      scope,
      scopeId,
      visibility,
      syncTargets,
    });
  };

  const title = initial?.fromCatalog
    ? `Add ${initial.fromCatalog.name}`
    : "New Skill";

  return (
    <AdaptiveModalSheet title={title} visible={visible} onClose={onClose}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Field label="Skill Name">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="my-skill"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </Field>

        <Field label="Display Name">
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="My Skill"
            style={styles.input}
          />
        </Field>

        <Field label="Description">
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="One-line summary"
            style={styles.input}
            multiline
          />
        </Field>

        <Field label="Instructions (SKILL.md content)">
          {loadingBody ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" />
              <Text style={styles.loadingText}>Loading skill content…</Text>
            </View>
          ) : null}
          {bodyError ? (
            <Text style={styles.errorText}>Couldn't load: {bodyError}</Text>
          ) : null}
          <TextInput
            value={instructions}
            onChangeText={setInstructions}
            placeholder={"# Title\n\nWhen to use this skill, what it does, examples…"}
            multiline
            numberOfLines={10}
            style={[styles.input, styles.multiline]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>

        <Field label="Example Prompt (optional)">
          <TextInput
            value={examplePrompt}
            onChangeText={setExamplePrompt}
            placeholder="Use this skill to…"
            style={styles.input}
          />
        </Field>

        <ScopeVisibilityPicker
          scope={scope}
          scopeId={scopeId}
          visibility={visibility}
          onChange={(patch) => {
            if (patch.scope !== undefined) setScope(patch.scope);
            if (patch.scopeId !== undefined) setScopeId(patch.scopeId);
            if (patch.visibility !== undefined) setVisibility(patch.visibility);
          }}
          activeOrgId={activeOrgId}
          activeProjectId={activeProjectId}
        />

        <SyncTargetsPicker
          transport="stdio"
          value={syncTargets}
          onChange={setSyncTargets}
          surface="skill"
        />

        <View style={styles.actions}>
          <Pressable
            onPress={onClose}
            style={({ hovered }) => [styles.cancelBtn, hovered && styles.cancelBtnHovered]}
            accessibilityRole="button"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            disabled={!isValid || submitting}
            style={({ hovered }) => [
              styles.submitBtn,
              (!isValid || submitting) && styles.submitBtnDisabled,
              isValid && !submitting && hovered && styles.submitBtnHovered,
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.submitText}>{submitting ? "Adding…" : "Add"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  field: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
  },
  input: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  multiline: {
    minHeight: 200,
    textAlignVertical: "top" as const,
    paddingTop: 10,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  loadingText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  cancelBtn: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cancelBtnHovered: {
    backgroundColor: theme.colors.surface2,
  },
  cancelText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foreground,
  },
  submitBtn: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  submitBtnHovered: {
    backgroundColor: theme.colors.accentBright,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600" as const,
    color: theme.colors.accentForeground,
  },
}));
