// PlainThreadSelector — adapted from emdash for React Native
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { View, Text, Pressable, TextInput, FlatList, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Search, X } from "lucide-react-native";
import type { PlainThreadSummary } from "@/types/integrations";

interface PlainThreadSelectorProps {
  threads?: PlainThreadSummary[];
  selectedThreadId?: string | null;
  onSelect: (thread: PlainThreadSummary | null) => void;
  onSearch?: (query: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}

export function PlainThreadSelector({
  threads = [],
  selectedThreadId,
  onSelect,
  onSearch,
  isLoading = false,
  placeholder = "Search Plain threads...",
}: PlainThreadSelectorProps) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) || null,
    [threads, selectedThreadId],
  );

  const filteredThreads = useMemo(() => {
    if (!statusFilter) return threads;
    return threads.filter((t) => t.status === statusFilter);
  }, [threads, statusFilter]);

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
      <View style={pStyles.selectedContainer}>
        <Text style={pStyles.selectedTitle} numberOfLines={1}>
          {selected.title}
        </Text>
        {selected.customer?.fullName ? (
          <Text style={pStyles.selectedSub}>{selected.customer.fullName}</Text>
        ) : null}
        <Pressable onPress={() => onSelect(null)} style={pStyles.clearBtn}>
          <X size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={pStyles.container}>
      <View style={pStyles.searchRow}>
        <Search size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          style={pStyles.input}
          value={query}
          onChangeText={handleQueryChange}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
        {isLoading ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
      </View>
      {isOpen ? (
        <View style={pStyles.filterRow}>
          {["TODO", "SNOOZED", "DONE"].map((s) => (
            <Pressable
              key={s}
              style={[pStyles.filterChip, statusFilter === s && pStyles.filterChipActive]}
              onPress={() => setStatusFilter(statusFilter === s ? null : s)}
            >
              <Text
                style={[pStyles.filterChipText, statusFilter === s && pStyles.filterChipTextActive]}
              >
                {s}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {isOpen && filteredThreads.length > 0 ? (
        <View style={pStyles.dropdown}>
          <FlatList
            data={filteredThreads.slice(0, 10)}
            keyExtractor={(i) => i.id}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [pStyles.row, pressed && pStyles.rowPressed]}
                onPress={() => {
                  onSelect(item);
                  setIsOpen(false);
                }}
              >
                <View style={pStyles.rowContent}>
                  <Text style={pStyles.rowTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.customer?.fullName ? (
                    <Text style={pStyles.rowSub}>{item.customer.fullName}</Text>
                  ) : null}
                </View>
                {item.status ? <Text style={pStyles.rowStatus}>{item.status}</Text> : null}
              </Pressable>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const pStyles = StyleSheet.create((theme) => ({
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
  filterRow: { flexDirection: "row", gap: theme.spacing[1] },
  filterChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  filterChipActive: { backgroundColor: theme.colors.foreground },
  filterChipText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  filterChipTextActive: { color: theme.colors.surface1 },
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
  rowStatus: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  selectedContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  selectedTitle: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  selectedSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  clearBtn: { padding: theme.spacing[1] },
}));
