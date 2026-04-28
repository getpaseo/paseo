// GitHubIssueSelector — adapted from emdash for React Native

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { View, Text, Pressable, TextInput, FlatList, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Search, X } from "lucide-react-native";
import type { GitHubIssueSummary } from "@/types/integrations";

interface GitHubIssueSelectorProps {
  issues?: GitHubIssueSummary[];
  selectedIssueId?: number | null;
  onSelect: (issue: GitHubIssueSummary | null) => void;
  onSearch?: (query: string) => void;
  isLoading?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export function GitHubIssueSelector({
  issues = [],
  selectedIssueId,
  onSelect,
  onSearch,
  isLoading = false,
  placeholder = "Search GitHub issues...",
  disabled = false,
}: GitHubIssueSelectorProps) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedIssue = useMemo(
    () => issues.find((i) => i.id === selectedIssueId) || null,
    [issues, selectedIssueId],
  );

  const handleQueryChange = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onSearch?.(text);
      }, 300);
    },
    [onSearch],
  );

  const handleSelect = useCallback(
    (issue: GitHubIssueSummary) => {
      onSelect(issue);
      setIsOpen(false);
      setQuery("");
    },
    [onSelect],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  if (selectedIssue) {
    return (
      <View style={sStyles.selectedContainer}>
        <View style={sStyles.selectedContent}>
          <Text style={sStyles.selectedIdentifier}>#{selectedIssue.number}</Text>
          <Text style={sStyles.selectedTitle} numberOfLines={1}>
            {selectedIssue.title}
          </Text>
        </View>
        <Pressable onPress={() => onSelect(null)} style={sStyles.clearButton}>
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
          style={sStyles.searchInput}
          value={query}
          onChangeText={handleQueryChange}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          editable={!disabled}
          autoCapitalize="none"
        />
        {isLoading ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
      </View>
      {isOpen && issues.length > 0 ? (
        <View style={sStyles.dropdown}>
          <FlatList
            data={issues.slice(0, 10)}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [sStyles.issueRow, pressed && sStyles.issueRowPressed]}
                onPress={() => handleSelect(item)}
              >
                <Text style={sStyles.issueIdentifier}>#{item.number}</Text>
                <Text style={sStyles.issueTitle} numberOfLines={1}>
                  {item.title}
                </Text>
              </Pressable>
            )}
            style={sStyles.dropdownList}
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
  searchInput: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground, padding: 0 },
  dropdown: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    maxHeight: 200,
    overflow: "hidden",
  },
  dropdownList: { maxHeight: 200 },
  issueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  issueRowPressed: { backgroundColor: theme.colors.surface2 },
  issueIdentifier: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  issueTitle: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  selectedContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  selectedContent: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  selectedIdentifier: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  selectedTitle: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  clearButton: { padding: theme.spacing[1] },
}));
