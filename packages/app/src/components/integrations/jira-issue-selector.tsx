// JiraIssueSelector — adapted from emdash for React Native
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { View, Text, Pressable, TextInput, FlatList, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Search, X } from "lucide-react-native";
import type { JiraIssueSummary } from "@/types/integrations";

interface JiraIssueSelectorProps {
  issues?: JiraIssueSummary[];
  selectedIssueId?: string | null;
  onSelect: (issue: JiraIssueSummary | null) => void;
  onSearch?: (query: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}

export function JiraIssueSelector({
  issues = [],
  selectedIssueId,
  onSelect,
  onSearch,
  isLoading = false,
  placeholder = "Search Jira issues...",
}: JiraIssueSelectorProps) {
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
      <View style={jStyles.selectedContainer}>
        <Text style={jStyles.selectedId}>{selected.key}</Text>
        <Text style={jStyles.selectedTitle} numberOfLines={1}>
          {selected.title}
        </Text>
        <Pressable onPress={() => onSelect(null)} style={jStyles.clearBtn}>
          <X size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={jStyles.container}>
      <View style={jStyles.searchRow}>
        <Search size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          style={jStyles.input}
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
        <View style={jStyles.dropdown}>
          <FlatList
            data={issues.slice(0, 10)}
            keyExtractor={(i) => i.id}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [jStyles.row, pressed && jStyles.rowPressed]}
                onPress={() => {
                  onSelect(item);
                  setIsOpen(false);
                }}
              >
                <Text style={jStyles.rowId}>{item.key}</Text>
                <Text style={jStyles.rowTitle} numberOfLines={1}>
                  {item.title}
                </Text>
              </Pressable>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const jStyles = StyleSheet.create((theme) => ({
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
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  rowPressed: { backgroundColor: theme.colors.surface2 },
  rowId: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  rowTitle: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  selectedContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  selectedId: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  selectedTitle: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  clearBtn: { padding: theme.spacing[1] },
}));
