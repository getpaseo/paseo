import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { addAccountCopy } from "./copy";

type AccountKind = "codex" | "claude";
const SNAP_POINTS = ["60%"];
const HOME_VARIABLE: Record<AccountKind, string> = {
  codex: "CODEX_HOME",
  claude: "CLAUDE_CONFIG_DIR",
};

export function accountProfileId(kind: AccountKind, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${kind}-${slug}` : kind;
}

// The login folders of existing profiles tell where the host's home is; a new account's folder
// defaults next to them, e.g. /home/admin/.codex-privat.
function suggestFolder(id: string, knownFolders: string[]): string {
  const known = knownFolders.find((folder) => /\/\.[a-z]+[^/]*$/.test(folder));
  const home = known ? known.replace(/\/[^/]+$/, "") : "~";
  return `${home}/.${id}`;
}

/** Adds a Codex or Claude account as a provider profile with its own login folder. */
export function AddAccountSheet(input: {
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { serverId, visible, onClose } = input;
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [kind, setKind] = useState<AccountKind>("codex");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ id: string; folder: string } | null>(null);

  const id = accountProfileId(kind, name);
  const knownFolders = useMemo(
    () =>
      Object.values(config?.providers ?? {}).flatMap((provider) =>
        Object.values(provider?.env ?? {}).filter((value) => value.startsWith("/")),
      ),
    [config?.providers],
  );
  const resolvedFolder = folder.trim() || suggestFolder(id, knownFolders);
  const taken = Boolean(config?.providers?.[id]);
  const canSave = name.trim().length > 0 && !taken && resolvedFolder.startsWith("/") && !saving;

  useEffect(() => {
    if (!visible) {
      setName("");
      setFolder("");
      setError(null);
      setCreated(null);
    }
  }, [visible]);

  const handleSave = useCallback(() => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    void patchConfig({
      providers: {
        [id]: {
          extends: kind,
          label: name.trim(),
          env: { [HOME_VARIABLE[kind]]: resolvedFolder },
        },
      },
    })
      .then(() => {
        setCreated({ id, folder: resolvedFolder });
        return undefined;
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : addAccountCopy.failed))
      .finally(() => setSaving(false));
  }, [canSave, id, kind, name, patchConfig, resolvedFolder]);

  const header = useMemo<SheetHeader>(() => ({ title: addAccountCopy.title }), []);
  const inputStyle = [styles.input, isWeb && ({ outlineStyle: "none" } as object)];
  const loginCommand = created
    ? `${HOME_VARIABLE[kind]}=${created.folder} ${kind === "codex" ? "codex login" : "claude /login"}`
    : "";

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={460}
      snapPoints={SNAP_POINTS}
      keyboardBehavior="interactive"
      testID="add-usage-account-sheet"
    >
      {created ? (
        <View style={styles.group} testID="add-usage-account-created">
          <Text style={styles.label}>{addAccountCopy.created}</Text>
          <Text style={styles.muted}>{addAccountCopy.loginHint}</Text>
          <Text style={styles.mono} selectable>
            {loginCommand}
          </Text>
          <View style={styles.actions}>
            <Button variant="default" size="sm" onPress={onClose}>
              {addAccountCopy.done}
            </Button>
          </View>
        </View>
      ) : (
        <View style={styles.group}>
          <View style={styles.kindRow}>
            {(["codex", "claude"] as const).map((option) => (
              <KindButton key={option} kind={option} active={kind === option} onSelect={setKind} />
            ))}
          </View>
          <Text style={styles.label}>{addAccountCopy.name}</Text>
          <AdaptiveTextInput
            initialValue={name}
            resetKey={`add-account-name-${visible}`}
            onChangeText={setName}
            placeholder={addAccountCopy.namePlaceholder}
            autoCorrect={false}
            testID="add-usage-account-name"
            style={inputStyle}
          />
          <Text style={styles.label}>{addAccountCopy.folder}</Text>
          <AdaptiveTextInput
            initialValue={folder}
            resetKey={`add-account-folder-${visible}`}
            onChangeText={setFolder}
            placeholder={resolvedFolder}
            autoCapitalize="none"
            autoCorrect={false}
            testID="add-usage-account-folder"
            style={inputStyle}
          />
          {taken ? <Text style={styles.error}>{addAccountCopy.taken}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
              {addAccountCopy.cancel}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSave}
              disabled={!canSave}
              testID="add-usage-account-save"
            >
              {addAccountCopy.save}
            </Button>
          </View>
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

function KindButton(input: {
  kind: AccountKind;
  active: boolean;
  onSelect: (kind: AccountKind) => void;
}) {
  const { kind, onSelect } = input;
  const handlePress = useCallback(() => onSelect(kind), [kind, onSelect]);
  return (
    <Button
      variant={input.active ? "default" : "secondary"}
      size="sm"
      onPress={handlePress}
      testID={`add-usage-account-kind-${kind}`}
    >
      {kind === "codex" ? "Codex" : "Claude"}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[3] },
  kindRow: { flexDirection: "row", gap: theme.spacing[2] },
  label: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.destructive },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
