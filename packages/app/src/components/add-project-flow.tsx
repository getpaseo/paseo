import { router } from "expo-router";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  ArrowLeft,
  Folder,
  FolderOpen,
  FolderPlus,
  Github,
  HardDrive,
  Plus,
  Server,
} from "lucide-react-native";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  applyAvailableAddProjectHosts,
  backAddProjectPage,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectSelection,
  openAddProjectFlow,
  openGithubLocationPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setNewDirectoryName,
  updateCurrentAddProjectPage,
  type AddProjectFlowState,
  type AddProjectHost,
  type AddProjectPage,
  type GithubRepositoryChoice,
} from "@/add-project-flow/model";
import {
  buildAddProjectSourceOptions,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
  buildSuggestedParentDirectories,
  canUseGithubSource,
  filterAddProjectHosts,
  joinDirectoryPath,
  pathBaseName,
  resolveAddProjectSourceFilter,
  type AddProjectSourceFilter,
} from "@/add-project-flow/options";
import {
  readAddProjectSourceFilter,
  useAddProjectFilterStore,
} from "@/add-project-flow/filter-store";
import {
  buildProjectPickerOptions,
  type ProjectPickerOption,
} from "@/components/project-picker-options";
import { Shortcut } from "@/components/ui/shortcut";
import { getIsElectronRuntime } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { pickDirectory } from "@/desktop/pick-directory";
import { useFetchQuery } from "@/data/query";
import { getOpenProjectFailureReason, registerProjectDescriptor } from "@/hooks/open-project";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useCloneGithubProject, useOpenProject } from "@/hooks/use-open-project";
import {
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import {
  useHosts,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import type { AddProjectFlowRequest } from "@/stores/add-project-flow-store";
import type { Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";
import { buildNewWorkspaceRoute, buildSettingsAddHostRoute } from "@/utils/host-routes";

interface AddProjectFlowProps {
  request: AddProjectFlowRequest;
  onClose: () => void;
}

interface FlowRowOption {
  id: string;
  title: string;
  subtitle: string | null;
  icon: ComponentType<{ size?: number; color?: string }>;
  disabled?: boolean;
  /** Group headers render as plain labels and are never selectable. */
  header?: boolean;
  testID: string;
  select: () => void;
}

type GithubLocationPage = Extract<AddProjectPage, { kind: "github-location" }>;

interface FlowIconProps {
  icon: ComponentType<{ size?: number; color?: string }>;
  size?: number;
  color?: string;
}

function FlowIcon({ icon: Icon, size, color }: FlowIconProps) {
  return <Icon size={size} color={color} />;
}

const MutedFlowIcon = withUnistyles(FlowIcon, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const lastCloneParentByHost = new Map<string, string>();
const EMPTY_PATHS: string[] = [];
const NAVIGATION_HINT_KEYS = ["Up", "Down"];
const SELECT_HINT_KEYS = ["Enter"];
const ESCAPE_HINT_KEYS = ["Esc"];

function FlowBackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={styles.backButton}
      accessibilityRole="button"
      accessibilityLabel="Back"
      testID="add-project-flow-back"
    >
      {({ hovered, pressed }) => (
        <ThemedArrowLeft
          size={18}
          uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
        />
      )}
    </Pressable>
  );
}

function directoryOptionSubtitle(option: ProjectPickerOption, shortPath: string): string | null {
  if (option.kind === "path") return "Open this path";
  if (shortPath === option.path) return null;
  return option.path;
}

function progressText(page: AddProjectPage): string {
  if (page.kind === "github-location") return "Cloning project...";
  if (page.kind === "new-directory-name") return "Creating directory...";
  return "Adding project...";
}

function emptyText(page: AddProjectPage, host: AddProjectHost | null): string {
  if (page.kind === "host") return "No connected hosts";
  if (page.kind === "search") {
    return host?.canAddProject === false
      ? "Update the host to use Add Project."
      : "No matching options";
  }
  return "No matching options";
}

interface QueryErrorInput {
  searchesDirectories: boolean;
  directoryFailed: boolean;
  githubFailed: boolean;
  githubAvailable: boolean | null;
  githubError: string | null;
}

function queryErrorText(input: QueryErrorInput): string | null {
  if (input.searchesDirectories && input.directoryFailed) return "Unable to search directories";
  if (input.githubFailed) return "Unable to search GitHub repositories";
  if (input.githubError) return input.githubError;
  if (input.githubAvailable === false) return input.githubError ?? "GitHub search is unavailable";
  return null;
}

function pageHostId(page: AddProjectPage): string | null {
  return page.kind === "host" ? null : page.hostId;
}

function pageTitle(page: AddProjectPage): string {
  switch (page.kind) {
    case "host":
      return "Choose host";
    case "search":
      return "Add project";
    case "github-location":
      return "Choose destination";
    case "new-directory-parent":
      return "Choose parent directory";
    case "new-directory-name":
      return "Name directory";
  }
}

function pagePlaceholder(page: AddProjectPage): string {
  switch (page.kind) {
    case "host":
      return "Search hosts...";
    case "search":
      return "Search directories and GitHub, or enter a path...";
    case "github-location":
    case "new-directory-parent":
      return "Search parent directories or enter a path...";
    case "new-directory-name":
      return "Directory name";
  }
}

function pageInput(page: AddProjectPage): string {
  return page.kind === "new-directory-name" ? page.name : page.query;
}

function pathTestId(path: string): string {
  return `add-project-flow-path-${encodeURIComponent(path)}`;
}

function FlowRow({ option, active }: { option: FlowRowOption; active: boolean }) {
  const accessibilityState = useMemo(
    () => ({ disabled: option.disabled === true, selected: active }),
    [active, option.disabled],
  );
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (active || hovered || pressed) && styles.rowActive,
      option.disabled && styles.disabled,
    ],
    [active, option.disabled],
  );
  if (option.header) {
    return (
      <Text style={styles.groupHeader} testID={option.testID}>
        {option.title}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={option.disabled}
      onPress={option.select}
      style={rowStyle}
      testID={option.testID}
    >
      <View style={styles.iconSlot}>
        <MutedFlowIcon icon={option.icon} size={16} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {option.title}
        </Text>
        {option.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {option.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function FlowHint({ keys, action }: { keys: string[]; action: string }) {
  return (
    <View style={styles.footerHint}>
      <Shortcut keys={keys} textStyle={styles.footerKeyText} />
      <Text style={styles.footerAction}>{action}</Text>
    </View>
  );
}

function SourcePill({
  id,
  label,
  active,
  testID,
  onSelect,
}: {
  id: AddProjectSourceFilter;
  label: string;
  active: boolean;
  testID: string;
  onSelect: (filter: AddProjectSourceFilter) => void;
}) {
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const handlePress = useCallback(() => onSelect(id), [id, onSelect]);
  const pillStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.pill,
      (active || hovered || pressed) && styles.pillActive,
    ],
    [active],
  );
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID={testID}
      style={pillStyle}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

type SearchPage = Extract<AddProjectPage, { kind: "search" }>;

function buildSearchRows(input: {
  page: SearchPage;
  host: AddProjectHost;
  sourceFilter: AddProjectSourceFilter;
  pathOptions: ProjectPickerOption[];
  githubPayload: { repositories?: GithubRepositoryChoice[] } | null;
  query: string;
  openAddedProject: (path: string) => void;
  browse: () => void;
  setState: (update: (current: AddProjectFlowState) => AddProjectFlowState) => void;
}): FlowRowOption[] {
  const { page, host, sourceFilter, pathOptions, query } = input;
  if (!host.canAddProject) {
    return [
      {
        id: "host-update-required",
        title: "Update the host to use Add Project.",
        subtitle: null,
        icon: Server,
        disabled: true,
        testID: "add-project-flow-host-update-required",
        select: () => undefined,
      },
    ];
  }
  const rows: FlowRowOption[] = [];
  if (sourceFilter !== "github") {
    rows.push({
      id: "header:local",
      title: "Local",
      subtitle: null,
      icon: Folder,
      header: true,
      disabled: true,
      testID: "add-project-flow-group-local",
      select: () => undefined,
    });
    for (const option of pathOptions) {
      const shortPath = shortenPath(option.path);
      rows.push({
        id: option.path,
        title: shortPath,
        subtitle: directoryOptionSubtitle(option, shortPath),
        icon: Folder,
        testID: pathTestId(option.path),
        select: () => input.openAddedProject(option.path),
      });
    }
    if (pathOptions.length === 0) {
      rows.push({
        id: "empty:local",
        title: "No matching directories",
        subtitle: null,
        icon: Folder,
        disabled: true,
        testID: "add-project-flow-empty-local",
        select: () => undefined,
      });
    }
    if (host.canCreateDirectory) {
      rows.push({
        id: "action:new-directory",
        title: "New directory",
        subtitle: `Create an empty directory on ${host.label}`,
        icon: FolderPlus,
        testID: "add-project-flow-action-new-directory",
        select: () => input.setState((current) => openNewDirectoryParentPage(current, page.hostId)),
      });
    }
    if (host.canBrowse) {
      rows.push({
        id: "action:browse",
        title: "Browse",
        subtitle: "Choose or create a directory in Finder",
        icon: FolderOpen,
        testID: "add-project-flow-action-browse",
        select: () => input.browse(),
      });
    }
  }
  if (sourceFilter !== "local" && canUseGithubSource(host)) {
    rows.push({
      id: "header:github",
      title: "GitHub",
      subtitle: null,
      icon: Github,
      header: true,
      disabled: true,
      testID: "add-project-flow-group-github",
      select: () => undefined,
    });
    const repositories = input.githubPayload?.repositories ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    const hasExactSearchResult = repositories.some(
      (repository) =>
        repository.nameWithOwner.toLowerCase() === normalizedQuery ||
        repository.cloneUrl.toLowerCase() === normalizedQuery,
    );
    const manualRepositories = hasExactSearchResult
      ? []
      : buildManualGithubRepositoryChoices(query);
    const repositoryChoices: GithubRepositoryChoice[] = [...manualRepositories, ...repositories];
    for (const repository of repositoryChoices) {
      rows.push({
        id: repository.id,
        title: repository.cloneProtocol
          ? `${repository.nameWithOwner} via ${repository.cloneProtocol.toUpperCase()}`
          : repository.nameWithOwner,
        subtitle: repository.description,
        icon: Github,
        testID: `add-project-flow-repository-${repository.id}`,
        select: () =>
          input.setState((current) => openGithubLocationPage(current, page.hostId, repository)),
      });
    }
    if (repositoryChoices.length === 0) {
      rows.push({
        id: "empty:github",
        title: host.canSearchGithubRepositories
          ? "No matching repositories"
          : "Enter a GitHub URL or owner/repo",
        subtitle: null,
        icon: Github,
        disabled: true,
        testID: "add-project-flow-empty-github",
        select: () => undefined,
      });
    }
  }
  return rows;
}

function setPageStatus(
  state: AddProjectFlowState,
  kind: AddProjectPage["kind"],
  input: { isSubmitting?: boolean; error?: string | null },
): AddProjectFlowState {
  return updateCurrentAddProjectPage(state, (page) =>
    page.kind === kind ? { ...page, ...input } : page,
  );
}

// The product flow is intentionally one cohesive page-stack state machine.
// eslint-disable-next-line complexity
export function AddProjectFlow({ request, onClose }: AddProjectFlowProps) {
  const hosts = useHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(hostIds);
  const projectAddByHost = useHostFeatureMap(hostIds, "projectAdd");
  // COMPAT(stableProjectIdentity): added in v0.1.109, remove gate after 2027-01-15.
  const stableProjectIdentityByHost = useHostFeatureMap(hostIds, "stableProjectIdentity");
  // COMPAT(projectGithubClone): added in v0.1.108, remove gate after 2027-01-15.
  const githubCloneByHost = useHostFeatureMap(hostIds, "projectGithubClone");
  // COMPAT(workspaceGithubRepositorySearch): added in v0.1.108, remove gate after 2027-01-15.
  const githubSearchByHost = useHostFeatureMap(hostIds, "workspaceGithubRepositorySearch");
  // COMPAT(projectCreateDirectory): added in v0.1.108, remove gate after 2027-01-15.
  const createDirectoryByHost = useHostFeatureMap(hostIds, "projectCreateDirectory");
  const localServerId = useLocalDaemonServerId();
  const availableHosts = useMemo<AddProjectHost[]>(
    () =>
      hosts.flatMap((host) => {
        if (connectionStatuses.get(host.serverId) !== "online") return [];
        const canAddProject =
          projectAddByHost.get(host.serverId) === true &&
          stableProjectIdentityByHost.get(host.serverId) === true;
        return [
          {
            serverId: host.serverId,
            label: host.label,
            canAddProject,
            canBrowse: canAddProject && getIsElectronRuntime() && localServerId === host.serverId,
            canCloneGithubRepositories: githubCloneByHost.get(host.serverId) === true,
            canSearchGithubRepositories: githubSearchByHost.get(host.serverId) === true,
            canCreateDirectory: createDirectoryByHost.get(host.serverId) === true,
          },
        ];
      }),
    [
      connectionStatuses,
      createDirectoryByHost,
      githubCloneByHost,
      githubSearchByHost,
      hosts,
      localServerId,
      projectAddByHost,
      stableProjectIdentityByHost,
    ],
  );
  const [state, setState] = useState(() =>
    openAddProjectFlow({
      hosts: availableHosts,
      ...(request.preferredHostId ? { preferredHostId: request.preferredHostId } : {}),
    }),
  );
  const page = currentAddProjectPage(state);
  const hostId = pageHostId(page);
  const host = hostId ? state.hosts.find((candidate) => candidate.serverId === hostId) : null;
  const client = useHostRuntimeClient(hostId ?? "");
  const isLocalDaemon = useIsLocalDaemon(hostId ?? "");
  const recommendedPaths = useRecommendedProjectPaths(hostId);
  const openProject = useOpenProject(hostId);
  const cloneGithubProject = useCloneGithubProject(hostId);
  const upsertProject = useSessionStore((store) => store.upsertProject);
  const setHasHydratedWorkspaces = useSessionStore((store) => store.setHasHydratedWorkspaces);
  const inputRef = useRef<TextInput>(null);
  const submissionInFlightRef = useRef(false);
  const browseInFlightRef = useRef(false);
  const query = page.kind === "new-directory-name" ? "" : page.query;
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [debouncedGithubQuery, setDebouncedGithubQuery] = useState(query);
  const storedSourceFilter = useAddProjectFilterStore((store) =>
    readAddProjectSourceFilter(store.filterByHost, hostId),
  );
  const setHostFilter = useAddProjectFilterStore((store) => store.setHostFilter);
  const sourceFilter = host
    ? resolveAddProjectSourceFilter(host, storedSourceFilter)
    : ("all" as AddProjectSourceFilter);

  useEffect(() => {
    setState((current) =>
      applyAvailableAddProjectHosts(current, availableHosts, request.preferredHostId),
    );
  }, [availableHosts, request.preferredHostId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // GitHub search rides a slower, rate-limited API: pace it well behind the
  // local debounce instead of firing on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedGithubQuery(query), 600);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [page.kind]);

  const searchesDirectories =
    (page.kind === "search" && sourceFilter !== "github") ||
    page.kind === "github-location" ||
    page.kind === "new-directory-parent";
  const directoryQuery = useFetchQuery({
    queryKey: ["add-project-flow-directories", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) return { query: debouncedQuery, paths: [] as string[] };
      const payload = await client.getDirectorySuggestions({
        query: debouncedQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return {
        query: debouncedQuery,
        paths:
          payload.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ??
          [],
      };
    },
    enabled: Boolean(client && searchesDirectories),
    dataShape: "value",
    retry: false,
    staleTimeMs: 15_000,
  });
  const githubQuery = useFetchQuery({
    queryKey: ["add-project-flow-github", hostId, debouncedGithubQuery],
    queryFn: async () => {
      if (!client) throw new Error("Host is unavailable");
      const payload = await client.searchGithubRepositories({
        query: debouncedGithubQuery,
        limit: 30,
      });
      return { query: debouncedGithubQuery, payload };
    },
    enabled: Boolean(
      client &&
      page.kind === "search" &&
      sourceFilter !== "local" &&
      host?.canSearchGithubRepositories,
    ),
    dataShape: "value",
    retry: false,
    staleTimeMs: 15_000,
  });

  const handleBack = useCallback(() => {
    setState((current) => {
      const previous = backAddProjectPage(current);
      if (previous) return previous;
      onClose();
      return current;
    });
  }, [onClose]);

  const openNewWorkspaceForProject = useCallback(
    (serverId: string, project: WorkspaceProjectDescriptorPayload) => {
      onClose();
      router.push(
        buildNewWorkspaceRoute({
          serverId,
          projectId: project.projectId,
          sourceDirectory: project.projectRootPath,
          displayName: project.projectDisplayName,
        }),
      );
    },
    [onClose],
  );

  const openAddedProject = useCallback(
    async (path: string) => {
      if (!hostId || submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      setState((current) => setPageStatus(current, "search", { isSubmitting: true, error: null }));
      try {
        const result = await openProject(path);
        if (result.ok) {
          openNewWorkspaceForProject(hostId, result.project);
          return;
        }
        const reason = getOpenProjectFailureReason(result);
        const message =
          reason === "directory_not_found" ? "Directory not found" : "Unable to add project";
        setState((current) =>
          setPageStatus(current, "search", { isSubmitting: false, error: message }),
        );
      } catch {
        setState((current) =>
          setPageStatus(current, "search", {
            isSubmitting: false,
            error: "Unable to add project",
          }),
        );
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [hostId, openNewWorkspaceForProject, openProject],
  );

  const browse = useCallback(async () => {
    if (!hostId || !isLocalDaemon || browseInFlightRef.current) return;
    browseInFlightRef.current = true;
    try {
      const path = await pickDirectory();
      if (path) await openAddedProject(path);
    } catch {
      setState((current) =>
        setPageStatus(current, "search", { error: "Unable to browse for a directory" }),
      );
    } finally {
      browseInFlightRef.current = false;
    }
  }, [hostId, isLocalDaemon, openAddedProject]);

  const selectSourceFilter = useCallback(
    (filter: AddProjectSourceFilter) => {
      if (!hostId) return;
      setHostFilter(hostId, filter);
      setState((current) => setAddProjectActiveIndex(current, 0));
    },
    [hostId, setHostFilter],
  );

  const cycleSourceFilter = useCallback(
    (direction: 1 | -1) => {
      if (!host) return;
      const options = buildAddProjectSourceOptions(host);
      const index = options.findIndex((option) => option.id === sourceFilter);
      const next = options[(index + direction + options.length) % options.length];
      if (next) selectSourceFilter(next.id);
    },
    [host, selectSourceFilter, sourceFilter],
  );

  const directoryPaths = useMemo(
    () => (directoryQuery.data?.query === query ? directoryQuery.data.paths : EMPTY_PATHS),
    [directoryQuery.data, query],
  );
  const pathOptions = useMemo(
    () =>
      buildProjectPickerOptions({
        recommendedPaths,
        serverPaths: directoryPaths,
        query,
      }),
    [directoryPaths, query, recommendedPaths],
  );
  const cloneRepository = useCallback(
    async (locationPage: GithubLocationPage, parentPath: string) => {
      if (submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      setState((current) =>
        setPageStatus(current, "github-location", { isSubmitting: true, error: null }),
      );
      try {
        const result = await cloneGithubProject(
          locationPage.repository.cloneUrl,
          parentPath,
          locationPage.repository.cloneProtocol,
        );
        if (result.ok) {
          lastCloneParentByHost.set(locationPage.hostId, parentPath);
          openNewWorkspaceForProject(locationPage.hostId, result.project);
          return;
        }
        setState((current) =>
          setPageStatus(current, "github-location", {
            isSubmitting: false,
            error: result.error ?? "Unable to clone repository",
          }),
        );
      } catch (error) {
        setState((current) =>
          setPageStatus(current, "github-location", {
            isSubmitting: false,
            error: error instanceof Error ? error.message : "Unable to clone repository",
          }),
        );
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [cloneGithubProject, openNewWorkspaceForProject],
  );
  const rows = useMemo<FlowRowOption[]>(() => {
    if (page.kind === "host") {
      const choices = filterAddProjectHosts(state.hosts, page.query).map<FlowRowOption>(
        (choice) => ({
          id: choice.serverId,
          title: choice.label,
          subtitle: choice.serverId,
          icon: Server,
          testID: `add-project-flow-host-${choice.serverId}`,
          select: () => setState((current) => chooseAddProjectHost(current, choice.serverId)),
        }),
      );
      if (state.hosts.length === 0) {
        choices.push({
          id: "add-host",
          title: "Add host",
          subtitle: "No connected hosts",
          icon: Plus,
          testID: "add-project-flow-add-host",
          select: () => {
            onClose();
            router.push(buildSettingsAddHostRoute(Date.now()));
          },
        });
      }
      return choices;
    }
    if (page.kind === "search") {
      if (!host) return [];
      return buildSearchRows({
        page,
        host,
        sourceFilter,
        pathOptions,
        githubPayload: githubQuery.data?.query === query ? githubQuery.data.payload : null,
        query,
        openAddedProject,
        browse,
        setState,
      });
    }
    if (page.kind === "github-location") {
      const repositoryName = pathBaseName(page.repository.nameWithOwner);
      const lastParent = lastCloneParentByHost.get(page.hostId);
      const parents = buildSuggestedParentDirectories(recommendedPaths);
      const orderedParents = lastParent
        ? [lastParent, ...parents.filter((parent) => parent !== lastParent)]
        : parents;
      const filteredParents = buildProjectPickerOptions({
        recommendedPaths: orderedParents,
        serverPaths: directoryPaths,
        query: page.query,
      }).map((option) => option.path);
      return buildCloneLocationOptions({
        parents: filteredParents,
        repositoryName,
        existingPaths: [...recommendedPaths, ...directoryPaths],
      }).map((option) => ({
        id: option.id,
        title: shortenPath(option.displayPath),
        subtitle: option.secondaryText,
        icon: HardDrive,
        disabled: option.disabled,
        testID: pathTestId(option.displayPath),
        select: () => void cloneRepository(page, option.path),
      }));
    }
    if (page.kind === "new-directory-parent") {
      return pathOptions.map((option) => ({
        id: option.path,
        title: shortenPath(option.path),
        subtitle: option.kind === "path" ? "Use this parent" : option.path,
        icon: Folder,
        testID: pathTestId(option.path),
        select: () =>
          setState((current) => openNewDirectoryNamePage(current, page.hostId, option.path)),
      }));
    }
    return [];
  }, [
    browse,
    cloneRepository,
    directoryPaths,
    githubQuery.data,
    host,
    onClose,
    openAddedProject,
    page,
    pathOptions,
    query,
    recommendedPaths,
    sourceFilter,
    state.hosts,
  ]);

  const activeIndex = rows.length === 0 ? 0 : Math.min(page.activeIndex, rows.length - 1);
  const createDirectory = useCallback(async () => {
    if (page.kind !== "new-directory-name" || !client) return;
    const name = page.name.trim();
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      setState((current) =>
        setPageStatus(current, "new-directory-name", { error: "Enter a directory name" }),
      );
      return;
    }
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    setState((current) =>
      setPageStatus(current, "new-directory-name", { isSubmitting: true, error: null }),
    );
    try {
      const payload = await client.createProjectDirectory({
        parentPath: page.parentPath,
        name,
      });
      if (payload.error || !payload.project) {
        setState((current) =>
          setPageStatus(current, "new-directory-name", {
            isSubmitting: false,
            error: payload.error ?? "Unable to create directory",
          }),
        );
        return;
      }
      registerProjectDescriptor({
        serverId: page.hostId,
        project: payload.project,
        upsertProject,
        setHasHydratedWorkspaces,
      });
      openNewWorkspaceForProject(page.hostId, payload.project);
    } catch {
      setState((current) =>
        setPageStatus(current, "new-directory-name", {
          isSubmitting: false,
          error: "Unable to create directory",
        }),
      );
    } finally {
      submissionInFlightRef.current = false;
    }
  }, [client, openNewWorkspaceForProject, page, setHasHydratedWorkspaces, upsertProject]);

  const submitActive = useCallback(() => {
    if (page.kind === "new-directory-name") {
      void createDirectory();
      return;
    }
    const option = rows[activeIndex];
    if (option && !option.disabled) option.select();
  }, [activeIndex, createDirectory, page.kind, rows]);

  const handleKey = useCallback(
    (key: string): boolean => {
      if (key === "Escape") {
        handleBack();
        return true;
      }
      if (key === "Enter") {
        submitActive();
        return true;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        if (page.kind !== "search") return false;
        cycleSourceFilter(key === "ArrowRight" ? 1 : -1);
        return true;
      }
      if (key !== "ArrowDown" && key !== "ArrowUp") return false;
      const next = moveAddProjectSelection(
        activeIndex,
        rows.map((row) => row.disabled !== true),
        key === "ArrowDown" ? "next" : "previous",
      );
      setState((current) => setAddProjectActiveIndex(current, next));
      return true;
    },
    [activeIndex, cycleSourceFilter, handleBack, page.kind, rows, submitActive],
  );

  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb);
  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!handleKey(event.key)) return false;
      event.preventDefault();
      return true;
    },
    [handleKey],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  const handleNativeKeyPress = useCallback(
    ({ nativeEvent: { key } }: { nativeEvent: { key: string } }) => {
      if (
        key === "ArrowDown" ||
        key === "ArrowUp" ||
        key === "ArrowLeft" ||
        key === "ArrowRight" ||
        key === "Escape"
      ) {
        handleKey(key);
      }
    },
    [handleKey],
  );

  const handleInputChange = useCallback((value: string) => {
    setState((current) =>
      currentAddProjectPage(current).kind === "new-directory-name"
        ? setNewDirectoryName(current, value)
        : setAddProjectPageInput(current, value),
    );
  }, []);
  const isSubmitting = "isSubmitting" in page && page.isSubmitting;
  const currentGithubSearch =
    page.kind === "search" && githubQuery.data?.query === page.query
      ? githubQuery.data.payload
      : null;
  const loading =
    (searchesDirectories && (query !== debouncedQuery || directoryQuery.isFetching)) ||
    (page.kind === "search" &&
      host?.canSearchGithubRepositories === true &&
      sourceFilter !== "local" &&
      (query !== debouncedGithubQuery || githubQuery.isFetching));
  const queryError = queryErrorText({
    searchesDirectories,
    directoryFailed: directoryQuery.isError,
    githubFailed: page.kind === "search" && githubQuery.isError,
    githubAvailable: currentGithubSearch?.available ?? null,
    githubError: currentGithubSearch?.error ?? null,
  });
  const sourceOptions = host ? buildAddProjectSourceOptions(host) : [];
  const preview =
    page.kind === "new-directory-name" && page.name.trim()
      ? joinDirectoryPath(page.parentPath, page.name.trim())
      : null;

  const modal = (
    <Modal visible transparent animationType="fade" onRequestClose={isWeb ? undefined : handleBack}>
      <View style={styles.overlay} testID="add-project-flow">
        <Pressable style={styles.backdrop} onPress={onClose} testID="add-project-flow-backdrop" />
        <View
          ref={setWebOverlayScope}
          style={styles.panel}
          testID={`add-project-flow-page-${page.kind}`}
          accessibilityLabel={`Add project: ${page.kind}`}
        >
          <View style={styles.header}>
            <View style={styles.titleRow}>
              {state.pages.length > 1 ? <FlowBackButton onPress={handleBack} /> : null}
              <View style={styles.titleGroup} testID="add-project-flow-title">
                <Text style={styles.title} numberOfLines={1}>
                  {pageTitle(page)}
                </Text>
                {host ? (
                  <Text style={styles.hostContext} numberOfLines={1}>
                    {host.label}
                  </Text>
                ) : null}
              </View>
            </View>
            <ThemedTextInput
              key={page.kind}
              ref={inputRef}
              value={pageInput(page)}
              onChangeText={handleInputChange}
              onKeyPress={isWeb ? undefined : handleNativeKeyPress}
              onSubmitEditing={isWeb ? undefined : submitActive}
              placeholder={pagePlaceholder(page)}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSubmitting}
              returnKeyType="go"
              testID="add-project-flow-input"
            />
            {page.kind === "search" && sourceOptions.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.pillRow}
                contentContainerStyle={styles.pillRowContent}
                keyboardShouldPersistTaps="always"
                testID="add-project-flow-sources"
              >
                {sourceOptions.map((option) => (
                  <SourcePill
                    key={option.id}
                    id={option.id}
                    label={option.label}
                    active={sourceFilter === option.id}
                    testID={`add-project-flow-source-${option.id}`}
                    onSelect={selectSourceFilter}
                  />
                ))}
              </ScrollView>
            ) : null}
          </View>
          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
            testID="add-project-flow-results"
          >
            {preview ? (
              <Text style={styles.preview} testID="add-project-flow-path-preview">
                {shortenPath(preview)}
              </Text>
            ) : null}
            {isSubmitting ? (
              <Text style={styles.stateText} testID="add-project-flow-progress">
                {progressText(page)}
              </Text>
            ) : null}
            {!isSubmitting && page.error ? (
              <Text style={styles.errorText} testID="add-project-flow-error">
                {page.error}
              </Text>
            ) : null}
            {!isSubmitting && queryError ? (
              <Text style={styles.errorText} testID="add-project-flow-query-error">
                {queryError}
              </Text>
            ) : null}
            {!isSubmitting && loading ? (
              <Text style={styles.stateText} testID="add-project-flow-loading">
                Loading...
              </Text>
            ) : null}
            {!isSubmitting && !loading && !queryError
              ? rows.map((option, index) => (
                  <FlowRow key={option.id} option={option} active={index === activeIndex} />
                ))
              : null}
            {!isSubmitting &&
            !loading &&
            !queryError &&
            rows.length === 0 &&
            page.kind !== "new-directory-name" ? (
              <Text style={styles.stateText} testID="add-project-flow-empty">
                {emptyText(page, host ?? null)}
              </Text>
            ) : null}
          </ScrollView>
          <View style={styles.footer} testID="add-project-flow-footer">
            <FlowHint keys={NAVIGATION_HINT_KEYS} action="Navigate" />
            <FlowHint keys={SELECT_HINT_KEYS} action="Select" />
            <FlowHint keys={ESCAPE_HINT_KEYS} action={state.pages.length > 1 ? "Back" : "Close"} />
          </View>
        </View>
      </View>
    </Modal>
  );

  return createElement(OverlayLayerProvider, { layer: isWeb ? modalLayer : 0 }, modal);
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
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    ...theme.shadow.lg,
  },
  header: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  titleRow: {
    minHeight: theme.iconSize.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  backButton: {
    width: 18,
    height: theme.iconSize.lg,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  title: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  hostContext: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as object,
  pillRow: { flexGrow: 0, flexShrink: 0 },
  pillRowContent: { gap: theme.spacing[2], paddingVertical: theme.spacing[1] },
  pill: {
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  pillActive: { backgroundColor: theme.colors.surface2 },
  pillText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  pillTextActive: { color: theme.colors.foreground },
  groupHeader: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  results: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  resultsContent: { paddingVertical: theme.spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rowActive: { backgroundColor: theme.colors.surface1 },
  disabled: { opacity: theme.opacity[50] },
  iconSlot: { width: 18, alignItems: "center" },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  rowSubtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs, marginTop: 2 },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  footer: {
    flexShrink: 0,
    flexDirection: "row",
    gap: theme.spacing[4],
    alignItems: "center",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  footerKeyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  footerAction: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
