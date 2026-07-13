import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
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
import { Folder, Github } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  getOpenProjectFailureReason,
  type OpenProjectFailureReason,
  type WorkspaceGithubCloneProtocol,
} from "@/hooks/open-project";
import { useOpenGithubRepo, useOpenProject } from "@/hooks/use-open-project";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProjectPickerStore } from "@/stores/project-picker-store";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import { shortenPath } from "@/utils/shorten-path";
import { isNative } from "@/constants/platform";
import { ProjectPickerBrowseButton } from "./project-picker-browse-button";
import { isCompleteGitRemote } from "@getpaseo/protocol/git-remote";
import { buildProjectPickerOptions, type ProjectPickerOption } from "./project-picker-options";

type ProjectPickerMode = "local" | "github";

const DEFAULT_CLONE_TARGET_DIRECTORY = "~/workspace";
const CLONE_REPO_ERROR_MESSAGE = "Unable to clone that GitHub repository.";
const CLONE_PROTOCOL_ERROR_MESSAGE = "Choose HTTPS or SSH for owner/repo repository names.";

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

interface CloneProtocolButtonProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

function CloneProtocolButton({ label, active, onPress }: CloneProtocolButtonProps) {
  const { theme } = useUnistyles();
  const buttonStyle = useMemo(
    () => [
      styles.protocolButton,
      {
        borderColor: theme.colors.border,
        backgroundColor: active ? theme.colors.surface1 : "transparent",
      },
    ],
    [active, theme.colors.border, theme.colors.surface1],
  );
  const textStyle = useMemo(
    () => [
      styles.protocolButtonText,
      { color: active ? theme.colors.foreground : theme.colors.foregroundMuted },
    ],
    [active, theme.colors.foreground, theme.colors.foregroundMuted],
  );
  return (
    <Pressable style={buttonStyle} onPress={onPress} accessibilityRole="button">
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

interface GithubRepoFormProps {
  repo: string;
  cloneProtocol: WorkspaceGithubCloneProtocol | null;
  targetDirectory: string;
  needsCloneProtocol: boolean;
  isSubmitting: boolean;
  repoInputRef: RefObject<TextInput | null>;
  onChangeRepo: (text: string) => void;
  onChangeTargetDirectory: (text: string) => void;
  onSelectHttps: () => void;
  onSelectSsh: () => void;
  onSubmit: () => void;
}

function GithubRepoForm({
  repo,
  cloneProtocol,
  targetDirectory,
  needsCloneProtocol,
  isSubmitting,
  repoInputRef,
  onChangeRepo,
  onChangeTargetDirectory,
  onSelectHttps,
  onSelectSsh,
  onSubmit,
}: GithubRepoFormProps) {
  const { theme } = useUnistyles();
  const inputStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const labelStyle = useMemo(
    () => [styles.label, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  return (
    <View style={styles.githubForm}>
      <View style={styles.fieldGroup}>
        <Text style={labelStyle}>GitHub repo</Text>
        <TextInput
          ref={repoInputRef}
          value={repo}
          onChangeText={onChangeRepo}
          placeholder="owner/repo"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={inputStyle}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          returnKeyType="next"
        />
      </View>
      {needsCloneProtocol ? (
        <View style={styles.fieldGroup}>
          <Text style={labelStyle}>Clone protocol</Text>
          <View style={styles.protocolRow}>
            <CloneProtocolButton
              label="HTTPS"
              active={cloneProtocol === "https"}
              onPress={onSelectHttps}
            />
            <CloneProtocolButton
              label="SSH"
              active={cloneProtocol === "ssh"}
              onPress={onSelectSsh}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.fieldGroup}>
        <Text style={labelStyle}>Checkout directory</Text>
        <TextInput
          value={targetDirectory}
          onChangeText={onChangeTargetDirectory}
          placeholder={DEFAULT_CLONE_TARGET_DIRECTORY}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={inputStyle}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          returnKeyType="go"
          onSubmitEditing={onSubmit}
        />
      </View>
    </View>
  );
}

interface ProjectPickerKeyboardNavigationInput {
  open: boolean;
  mode: ProjectPickerMode;
  optionsLength: number;
  onClose: () => void;
  setActiveIndex: Dispatch<SetStateAction<number>>;
}

function useProjectPickerKeyboardNavigation({
  open,
  mode,
  optionsLength,
  onClose,
  setActiveIndex,
}: ProjectPickerKeyboardNavigationInput) {
  useEffect(() => {
    if (!open || isNative) return;

    function handler(event: KeyboardEvent) {
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Escape") return;

      if (key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (mode !== "local" || optionsLength === 0) return;
      event.preventDefault();
      setActiveIndex((current) => {
        const delta = key === "ArrowDown" ? 1 : -1;
        const next = current + delta;
        if (next < 0) return optionsLength - 1;
        if (next >= optionsLength) return 0;
        return next;
      });
    }

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [mode, onClose, open, optionsLength, setActiveIndex]);
}

interface GithubCloneModeInput {
  client: ReturnType<typeof useHostRuntimeClient>;
  serverId: string | null;
  openGithubRepo: ReturnType<typeof useOpenGithubRepo>;
  close: () => void;
}

function useGithubCloneMode({ client, serverId, openGithubRepo, close }: GithubCloneModeInput) {
  const [repo, setRepo] = useState("");
  const [cloneProtocol, setCloneProtocol] = useState<WorkspaceGithubCloneProtocol | null>(null);
  const [targetDirectory, setTargetDirectory] = useState(DEFAULT_CLONE_TARGET_DIRECTORY);
  const [cloneErrorText, setCloneErrorText] = useState<string | null>(null);
  const needsCloneProtocol = repo.trim().length > 0 && !isCompleteGitRemote(repo);

  const reset = useCallback(() => {
    setRepo("");
    setCloneProtocol(null);
    setTargetDirectory(DEFAULT_CLONE_TARGET_DIRECTORY);
    setCloneErrorText(null);
  }, []);

  const handleChangeRepo = useCallback((text: string) => {
    setRepo(text);
    if (isCompleteGitRemote(text)) {
      setCloneProtocol(null);
    }
    setCloneErrorText(null);
  }, []);

  const handleChangeTargetDirectory = useCallback((text: string) => {
    setTargetDirectory(text);
    setCloneErrorText(null);
  }, []);

  const handleSetHttpsProtocol = useCallback(() => {
    setCloneProtocol("https");
    setCloneErrorText(null);
  }, []);

  const handleSetSshProtocol = useCallback(() => {
    setCloneProtocol("ssh");
    setCloneErrorText(null);
  }, []);

  const handleCloneRepo = useCallback(async () => {
    const trimmedRepo = repo.trim();
    const trimmedTargetDirectory = targetDirectory.trim();
    if (!trimmedRepo || !trimmedTargetDirectory || !client || !serverId) return false;
    const repoIsCompleteRemote = isCompleteGitRemote(trimmedRepo);
    if (!repoIsCompleteRemote && !cloneProtocol) {
      setCloneErrorText(CLONE_PROTOCOL_ERROR_MESSAGE);
      return false;
    }

    setCloneErrorText(null);
    const didOpenProject = await openGithubRepo(
      trimmedRepo,
      trimmedTargetDirectory,
      repoIsCompleteRemote ? undefined : (cloneProtocol ?? undefined),
    );
    if (!didOpenProject) {
      setCloneErrorText(CLONE_REPO_ERROR_MESSAGE);
      return false;
    }
    close();
    return true;
  }, [client, cloneProtocol, close, openGithubRepo, repo, serverId, targetDirectory]);

  return {
    repo,
    cloneProtocol,
    targetDirectory,
    cloneErrorText,
    needsCloneProtocol,
    reset,
    handleChangeRepo,
    handleChangeTargetDirectory,
    handleSetHttpsProtocol,
    handleSetSshProtocol,
    handleCloneRepo,
  };
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
  const repoInputRef = useRef<TextInput>(null);
  const [mode, setMode] = useState<ProjectPickerMode>("local");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openErrorReason, setOpenErrorReason] = useState<OpenProjectFailureReason | null>(null);
  const openProject = useOpenProject(serverId);
  const openGithubRepo = useOpenGithubRepo(serverId);
  const supportsGithubClone =
    client?.getLastServerInfoMessage()?.features?.workspaceGithubClone === true;
  const {
    repo,
    cloneProtocol,
    targetDirectory,
    cloneErrorText,
    needsCloneProtocol,
    reset: resetGithubCloneMode,
    handleChangeRepo,
    handleChangeTargetDirectory,
    handleSetHttpsProtocol,
    handleSetSshProtocol,
    handleCloneRepo: cloneGithubRepo,
  } = useGithubCloneMode({ client, serverId, openGithubRepo, close });

  const directorySuggestionsQuery = useQuery({
    queryKey: ["project-picker-directory-suggestions", serverId, debouncedQuery],
    queryFn: async () => {
      if (!client) {
        return { query: debouncedQuery, paths: [] };
      }
      const result = await client.getDirectorySuggestions({
        query: debouncedQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return {
        query: debouncedQuery,
        paths:
          result.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ??
          [],
      };
    },
    enabled: Boolean(client) && isConnected && open && mode === "local",
    staleTime: 15_000,
    retry: false,
  });

  const options = useMemo(() => {
    const currentSuggestions =
      directorySuggestionsQuery.data?.query === query ? directorySuggestionsQuery.data : null;
    return buildProjectPickerOptions({
      recommendedPaths,
      serverPaths: currentSuggestions?.paths ?? [],
      query,
    });
  }, [directorySuggestionsQuery.data, query, recommendedPaths]);
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
      } catch {
        setOpenErrorReason("open_failed");
      } finally {
        setIsSubmitting(false);
      }
    },
    [client, close, openProject, serverId],
  );

  const handleCloneRepo = useCallback(async () => {
    setIsSubmitting(true);
    try {
      await cloneGithubRepo();
    } finally {
      setIsSubmitting(false);
    }
  }, [cloneGithubRepo]);

  const submitActiveOption = useCallback(() => {
    if (mode === "github") {
      void handleCloneRepo();
      return;
    }
    const option = options[activeIndex];
    if (!option) return;
    void handleSelectPath(option.path);
  }, [activeIndex, handleCloneRepo, handleSelectPath, mode, options]);

  const handleChangeQuery = useCallback((text: string) => {
    setQuery(text);
    setActiveIndex(0);
    setOpenErrorReason(null);
  }, []);

  const handleBrowseError = useCallback(() => {
    setOpenErrorReason("open_failed");
  }, []);

  const handleSetLocalMode = useCallback(() => {
    setMode("local");
    setActiveIndex(0);
  }, []);

  const handleSetGithubMode = useCallback(() => {
    setMode("github");
    setActiveIndex(0);
    setOpenErrorReason(null);
  }, []);

  useEffect(() => {
    if (open) {
      setMode("local");
      setQuery("");
      setDebouncedQuery("");
      resetGithubCloneMode();
      setActiveIndex(0);
      setOpenErrorReason(null);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open, resetGithubCloneMode]);

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      if (mode === "github") {
        repoInputRef.current?.focus();
        return;
      }
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [mode, open]);

  // Debounce the query that drives the (potentially multi-second) directory
  // suggestions RPC so fast typing doesn't fire a filesystem scan per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (!open || mode !== "local") return;
    if (activeIndex >= options.length) {
      setActiveIndex(options.length > 0 ? options.length - 1 : 0);
    }
  }, [activeIndex, mode, options.length, open]);

  useProjectPickerKeyboardNavigation({
    open,
    mode,
    optionsLength: options.length,
    onClose: close,
    setActiveIndex,
  });

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
  const cloneErrorTextStyle = useMemo(
    () => [styles.errorText, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );
  const modeButtonStyle = useCallback(
    (buttonMode: ProjectPickerMode) => [
      styles.modeButton,
      {
        borderColor: theme.colors.border,
        backgroundColor: mode === buttonMode ? theme.colors.surface1 : "transparent",
      },
    ],
    [mode, theme.colors.border, theme.colors.surface1],
  );
  const modeButtonTextStyle = useCallback(
    (buttonMode: ProjectPickerMode) => [
      styles.modeButtonText,
      { color: mode === buttonMode ? theme.colors.foreground : theme.colors.foregroundMuted },
    ],
    [mode, theme.colors.foreground, theme.colors.foregroundMuted],
  );

  if (!serverId) return null;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View style={panelStyle}>
          <View style={headerStyle}>
            <View style={styles.modeRow}>
              <Pressable style={modeButtonStyle("local")} onPress={handleSetLocalMode}>
                <Folder size={15} color={theme.colors.foregroundMuted} />
                <Text style={modeButtonTextStyle("local")}>Local folder</Text>
              </Pressable>
              {supportsGithubClone ? (
                <Pressable style={modeButtonStyle("github")} onPress={handleSetGithubMode}>
                  <Github size={15} color={theme.colors.foregroundMuted} />
                  <Text style={modeButtonTextStyle("github")}>GitHub repo</Text>
                </Pressable>
              ) : null}
            </View>

            {mode === "local" ? (
              <View style={styles.localInputRow}>
                <TextInput
                  testID="project-picker-input"
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
                <ProjectPickerBrowseButton
                  serverId={serverId}
                  disabled={isSubmitting}
                  onSelect={handleSelectPath}
                  onError={handleBrowseError}
                />
              </View>
            ) : (
              <GithubRepoForm
                repo={repo}
                cloneProtocol={cloneProtocol}
                targetDirectory={targetDirectory}
                needsCloneProtocol={needsCloneProtocol}
                isSubmitting={isSubmitting}
                repoInputRef={repoInputRef}
                onChangeRepo={handleChangeRepo}
                onChangeTargetDirectory={handleChangeTargetDirectory}
                onSelectHttps={handleSetHttpsProtocol}
                onSelectSsh={handleSetSshProtocol}
                onSubmit={handleCloneRepo}
              />
            )}
          </View>

          {mode === "local" ? (
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
          ) : (
            <ScrollView
              style={styles.results}
              contentContainerStyle={styles.resultsContent}
              keyboardShouldPersistTaps="always"
              showsVerticalScrollIndicator={false}
            >
              {cloneErrorText ? <Text style={cloneErrorTextStyle}>{cloneErrorText}</Text> : null}
              {isSubmitting ? <Text style={emptyTextStyle}>Cloning repository...</Text> : null}
            </ScrollView>
          )}
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
    gap: theme.spacing[3],
  },
  localInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  modeRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  modeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
  },
  modeButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  githubForm: {
    gap: theme.spacing[3],
  },
  fieldGroup: {
    gap: theme.spacing[1],
  },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0,
  },
  protocolRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  protocolButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
  },
  protocolButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  input: {
    flex: 1,
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
  errorText: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
}));
