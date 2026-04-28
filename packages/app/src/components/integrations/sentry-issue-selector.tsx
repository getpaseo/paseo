// SentryIssueSelector — adapted from emdash for React Native
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { View, Text, Pressable, TextInput, FlatList, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Search, X } from "lucide-react-native";
import type { SentryIssueSummary } from "@/types/integrations";

interface SentryIssueSelectorProps {
  issues?: SentryIssueSummary[];
  selectedIssueId?: string | null;
  onSelect: (issue: SentryIssueSummary | null) => void;
  onSearch?: (query: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}

export function SentryIssueSelector({
  issues = [],
  selectedIssueId,
  onSelect,
  onSearch,
  isLoading = false,
  placeholder = "Search Sentry issues...",
}: SentryIssueSelectorProps) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = useMemo(
    () => issues.find((i) => i.id === selectedIssueId) || null,
    [issues, selectedIssueId],
  );

  const handleQueryChange = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => onSearch?.(text), 300);
    },
    [onSearch],
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  if (selected) {
    return (
      <View style={sStyles.selectedContainer}>
        <View style={sStyles.selectedContent}>
          <Text style={sStyles.selectedTitle} numberOfLines={1}>
            {selected.title}
          </Text>
          {selected.culprit ? (
            <Text style={sStyles.selectedSub} numberOfLines={1}>
              {selected.culprit}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={() => onSelect(null)} style={sStyles.clearBtn}>
          <X size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={sStyles.container}>
      <View style={sStyles.searchRow}>
        <Search size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          style={sStyles.input}
          value={query}
          onChangeText={handleQueryChange}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
        {isLoading ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
      </View>
      {isOpen && issues.length > 0 ? (
        <View style={sStyles.dropdown}>
          <FlatList
            data={issues.slice(0, 10)}
            keyExtractor={(i) => i.id}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [sStyles.row, pressed && sStyles.rowPressed]}
                onPress={() => {
                  onSelect(item);
                  setIsOpen(false);
                }}
              >
                <View style={sStyles.rowContent}>
                  <Text style={sStyles.rowTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.culprit ? (
                    <Text style={sStyles.rowSub} numberOfLines={1}>
                      {item.culprit}
                    </Text>
                  ) : null}
                </View>
                {item.level ? (
                  <Text style={[sStyles.rowLevel, item.level === "error" && sStyles.rowLevelError]}>
                    {item.level}
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const sStyles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[1] },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  input: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground, padding: 0 },
  dropdown: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    maxHeight: 200,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  rowPressed: { backgroundColor: theme.colors.surface2 },
  rowContent: { flex: 1, gap: 2 },
  rowTitle: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  rowLevel: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  rowLevelError: { color: theme.colors.destructive },
  selectedContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  selectedContent: { flex: 1, gap: 2 },
  selectedTitle: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  selectedSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  clearBtn: { padding: theme.spacing[1] },
}));
