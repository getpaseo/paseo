import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus, X } from "lucide-react-native";

interface KeyValueEditorProps {
  label: string;
  addLabel?: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** When true, mask value inputs — env vars often hold secrets. */
  maskValues?: boolean;
}

/**
 * Light-weight key/value editor for env vars and HTTP headers. Renders one
 * row per entry plus an "+ Add" button. Stores a plain object upstream so
 * payloads serialize naturally for the library API.
 */
export function KeyValueEditor({
  label,
  addLabel,
  value,
  onChange,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
  maskValues,
}: KeyValueEditorProps) {
  const entries = Object.entries(value);

  const setKey = (index: number, nextKey: string) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      if (i === index) next[nextKey] = v;
      else next[k] = v;
    });
    onChange(next);
  };
  const setVal = (key: string, v: string) => {
    onChange({ ...value, [key]: v });
  };
  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const add = () => {
    // Pick a non-colliding placeholder key.
    let i = 0;
    let candidate = "";
    while (!candidate || candidate in value) {
      candidate = i === 0 ? "NEW_KEY" : `NEW_KEY_${i}`;
      i += 1;
    }
    onChange({ ...value, [candidate]: "" });
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      {entries.map(([k, v], i) => (
        <View key={`${i}-${k}`} style={styles.row}>
          <TextInput
            value={k}
            onChangeText={(next) => setKey(i, next)}
            style={[styles.input, styles.keyInput]}
            placeholder={keyPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            value={v}
            onChangeText={(next) => setVal(k, next)}
            style={[styles.input, styles.valInput]}
            placeholder={valuePlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!!maskValues}
          />
          <Pressable
            onPress={() => remove(k)}
            style={styles.removeBtn}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${k}`}
          >
            <X size={14} color="currentColor" />
          </Pressable>
        </View>
      ))}
      <Pressable onPress={add} style={styles.addBtn} accessibilityRole="button">
        <Plus size={14} color="currentColor" />
        <Text style={styles.addLabel}>{addLabel ?? "Add"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    gap: theme.spacing[2],
  },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  input: {
    flex: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  keyInput: {
    flex: 1.1,
  },
  valInput: {
    flex: 1.6,
  },
  removeBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    color: theme.colors.foregroundMuted,
  },
  addBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    color: theme.colors.foregroundMuted,
  },
  addLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foregroundMuted,
  },
}));
