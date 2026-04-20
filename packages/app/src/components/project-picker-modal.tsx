import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Folder } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { usePathname } from "expo-router";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { shortenPath } from "@/utils/shorten-path";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useOpenProject } from "@/hooks/use-open-project";
import { parseServerIdFromPathname } from "@/utils/host-routes";
import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";
import { isNative } from "@/constants/platform";

export function ProjectPickerModal() {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const daemons = useHosts();

  const open = useKeyboardShortcutsStore((s) => s.projectPickerOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setProjectPickerOpen);

  const serverId = useMemo(() => {
    const fromPath = parseServerIdFromPathname(pathname);
    if (fromPath) return fromPath;
    return daemons[0]?.serverId ?? null;
  }, [pathname, daemons]);

  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const recommendedPaths = useRecommendedProjectPaths(serverId);

  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const openProject = useOpenProject(serverId);

  const directorySuggestionsQuery = useQuery({
    queryKey: ["project-picker-directory-suggestions", serverId, query],
    queryFn: async () => {
      if (!client) return [];
      const result = await client.getDirectorySuggestions({
        query,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return (
        result.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ?? []
      );
    },
    enabled: Boolean(client) && isConnected && open,
    staleTime: 15_000,
    retry: false,
  });

  const options = useMemo(
    () =>
      buildWorkingDirectorySuggestions({
        recommendedPaths,
        serverPaths: directorySuggestionsQuery.data ?? [],
        query,
      }),
    [query, directorySuggestionsQuery.data, recommendedPaths],
  );

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelectPath = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed || !client || !serverId) return;

      setIsSubmitting(true);
      try {
        const didOpenProject = await openProject(trimmed);
        if (didOpenProject) {
          setOpen(false);
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [client, openProject, serverId, setOpen],
  );

  const handleSubmitCustom = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    void handleSelectPath(trimmed);
  }, [handleSelectPath, query]);

  // Reset state when opening/closing
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Clamp active index
  useEffect(() => {
    if (!open) return;
    if (activeIndex >= options.length) {
      setActiveIndex(options.length > 0 ? options.length - 1 : 0);
    }
  }, [activeIndex, options.length, open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open || isNative) return;

    function handler(event: KeyboardEvent) {
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== "Escape") return;

      if (key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }

      if (key === "Enter") {
        event.preventDefault();
        if (options.length > 0 && activeIndex < options.length) {
          void handleSelectPath(options[activeIndex]!);
        } else if (query.trim()) {
          handleSubmitCustom();
        }
        return;
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        if (options.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = current + delta;
          if (next < 0) return options.length - 1;
          if (next >= options.length) return 0;
          return next;
        });
      }
    }

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeIndex, handleSelectPath, handleSubmitCustom, open, options, query, setOpen]);

  if (!serverId) return null;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View
          style={[
            styles.panel,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                setActiveIndex(0);
              }}
              placeholder="Type a directory path..."
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.input, { color: theme.colors.foreground }]}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!isSubmitting}
            />
          </View>

          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {isSubmitting ? (
              <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
                Opening project...
              </Text>
            ) : options.length === 0 && !query.trim() ? (
              <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
                Start typing a path
              </Text>
            ) : (
              <>
                {options.map((path, index) => {
                  const active = index === activeIndex;
                  return (
                    <Pressable
                      key={path}
                      style={({ hovered, pressed }) => [
                        styles.row,
                        (hovered || pressed || active) && {
                          backgroundColor: theme.colors.surface1,
                        },
                      ]}
                      onPress={() => void handleSelectPath(path)}
                    >
                      <View style={styles.rowContent}>
                        <View style={styles.iconSlot}>
                          <Folder
                            size={16}
                            strokeWidth={2.2}
                            color={theme.colors.foregroundMuted}
                          />
                        </View>
                        <Text
                          style={[styles.rowText, { color: theme.colors.foreground }]}
                          numberOfLines={1}
                        >
                          {shortenPath(path)}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: theme.spacing[12],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    width: 640,
    maxWidth: "92%",
    maxHeight: "80%",
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    ...theme.shadow.lg,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
  },
  input: {
    fontSize: theme.fontSize.lg,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as any,
  results: {
    flexGrow: 0,
  },
  resultsContent: {
    paddingVertical: theme.spacing[2],
  },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  iconSlot: {
    width: 16,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: {
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    flexShrink: 1,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    fontSize: theme.fontSize.base,
  },
}));
