import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getOpenProjectFailureReason, type OpenProjectFailureReason } from "@/hooks/open-project";
import { useOpenProject } from "@/hooks/use-open-project";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProjectPickerStore } from "@/stores/project-picker-store";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import { shortenPath } from "@/utils/shorten-path";
import { isNative } from "@/constants/platform";
import { buildProjectPickerOptions, type ProjectPickerOption } from "./project-picker-options";

interface PathRowProps {
  option: ProjectPickerOption;
  active: boolean;
  onSelect: (path: string) => void;
}

function PathRow({ option, active, onSelect }: PathRowProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const path = option.path;
  const handlePress = useCallback(() => {
    onSelect(path);
  }, [onSelect, path]);
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed || active) && {
        backgroundColor: theme.colors.surface1,
      },
    ],
    [active, theme.colors.surface1],
  );
  const rowTextStyle = useMemo(
    () => [styles.rowText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const rowActionTextStyle = useMemo(
    () => [styles.rowActionText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  return (
    <Pressable style={pressableStyle} onPress={handlePress}>
      <View style={styles.rowContent}>
        <View style={styles.iconSlot}>
          <Folder size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={rowTextStyle} numberOfLines={1}>
          {shortenPath(path)}
        </Text>
        {option.kind === "path" ? (
          <Text style={rowActionTextStyle}>{t("projectPicker.openPath")}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

interface ProjectPickerResultsProps {
  options: ProjectPickerOption[];
  activeIndex: number;
  isSubmitting: boolean;
  openErrorMessage: string | null;
  hasQuery: boolean;
  isSearching: boolean;
  emptyTextStyle: StyleProp<TextStyle>;
  errorTextStyle: StyleProp<TextStyle>;
  onSelect: (path: string) => void;
}

function ProjectPickerResults({
  options,
  activeIndex,
  isSubmitting,
  openErrorMessage,
  hasQuery,
  isSearching,
  emptyTextStyle,
  errorTextStyle,
  onSelect,
}: ProjectPickerResultsProps) {
  const { t } = useTranslation();
  const canShowResultState = !isSubmitting && !openErrorMessage;

  return (
    <ScrollView
      style={styles.results}
      contentContainerStyle={styles.resultsContent}
      keyboardShouldPersistTaps="always"
      showsVerticalScrollIndicator={false}
    >
      {isSubmitting ? <Text style={emptyTextStyle}>{t("projectPicker.opening")}</Text> : null}
      {!isSubmitting && openErrorMessage ? (
        <Text style={errorTextStyle}>{openErrorMessage}</Text>
      ) : null}
      {canShowResultState && options.length === 0 && !hasQuery ? (
        <Text style={emptyTextStyle}>{t("projectPicker.empty")}</Text>
      ) : null}
      {canShowResultState && isSearching ? (
        <Text style={emptyTextStyle}>{t("projectPicker.searching")}</Text>
      ) : null}
      {canShowResultState && !isSearching && options.length === 0 && hasQuery ? (
        <Text style={emptyTextStyle}>{t("common.empty.noOptionsMatchSearch")}</Text>
      ) : null}
      {canShowResultState && options.length > 0 ? (
        <>
          {options.map((option, index) => (
            <PathRow
              key={`${option.kind}:${option.path}`}
              option={option}
              active={index === activeIndex}
              onSelect={onSelect}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

export function ProjectPickerModal() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const request = useProjectPickerStore((state) => state.request);
  const close = useProjectPickerStore((state) => state.close);
  const serverId = request?.serverId ?? null;
  const open = request !== null;

  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const recommendedPaths = useRecommendedProjectPaths(serverId);

  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openErrorReason, setOpenErrorReason] = useState<OpenProjectFailureReason | null>(null);
  const openProject = useOpenProject(serverId);

  const directorySuggestionsQuery = useQuery({
    queryKey: ["project-picker-directory-suggestions", serverId, debouncedQuery],
    queryFn: async () => {
      if (!client) return [];
      const result = await client.getDirectorySuggestions({
        query: debouncedQuery,
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
      buildProjectPickerOptions({
        recommendedPaths,
        serverPaths: directorySuggestionsQuery.data ?? [],
        query,
      }),
    [directorySuggestionsQuery.data, query, recommendedPaths],
  );
  const hasQuery = query.trim().length > 0;
  const isSearching =
    hasQuery &&
    options.length === 0 &&
    (query !== debouncedQuery || directorySuggestionsQuery.isFetching);

  const openErrorMessage = useMemo(() => {
    if (!openErrorReason) {
      return null;
    }

    return t(`projectPicker.errors.${openErrorReason}`);
  }, [openErrorReason, t]);

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  const handleSelectPath = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed || !client || !serverId) return;

      setOpenErrorReason(null);
      setIsSubmitting(true);
      try {
        const result = await openProject(trimmed);
        if (result.ok) {
          close();
          return;
        }

        setOpenErrorReason(getOpenProjectFailureReason(result));
      } finally {
        setIsSubmitting(false);
      }
    },
    [client, close, openProject, serverId],
  );

  const submitActiveOption = useCallback(() => {
    const option = options[activeIndex];
    if (!option) return;
    void handleSelectPath(option.path);
  }, [activeIndex, handleSelectPath, options]);

  const handleChangeQuery = useCallback((text: string) => {
    setQuery(text);
    setActiveIndex(0);
    setOpenErrorReason(null);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setDebouncedQuery("");
      setActiveIndex(0);
      setOpenErrorReason(null);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Debounce the query that drives the (potentially multi-second) directory
  // suggestions RPC so fast typing doesn't fire a filesystem scan per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex >= options.length) {
      setActiveIndex(options.length > 0 ? options.length - 1 : 0);
    }
  }, [activeIndex, options.length, open]);

  useEffect(() => {
    if (!open || isNative) return;

    function handler(event: KeyboardEvent) {
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== "Escape") return;

      if (key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (key === "Enter") {
        event.preventDefault();
        submitActiveOption();
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
  }, [close, open, options.length, submitActiveOption]);

  const panelStyle = useMemo(
    () => [
      styles.panel,
      {
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
    ],
    [theme.colors.border, theme.colors.surface0],
  );
  const headerStyle = useMemo(
    () => [styles.header, { borderBottomColor: theme.colors.border }],
    [theme.colors.border],
  );
  const inputStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const emptyTextStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const errorTextStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );

  if (!serverId) return null;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View style={panelStyle}>
          <View style={headerStyle}>
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={handleChangeQuery}
              placeholder={t("projectPicker.placeholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!isSubmitting}
              returnKeyType="go"
              onSubmitEditing={submitActiveOption}
            />
          </View>

          <ProjectPickerResults
            options={options}
            activeIndex={activeIndex}
            isSubmitting={isSubmitting}
            openErrorMessage={openErrorMessage}
            hasQuery={hasQuery}
            isSearching={isSearching}
            emptyTextStyle={emptyTextStyle}
            errorTextStyle={errorTextStyle}
            onSelect={handleSelectPath}
          />
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
  } as object,
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
    flex: 1,
    flexShrink: 1,
  },
  rowActionText: {
    fontSize: theme.fontSize.xs,
    fontWeight: "500",
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    fontSize: theme.fontSize.base,
  },
}));
