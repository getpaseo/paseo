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
  Search,
  Server,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
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
import { i18n } from "@/i18n/i18next";
import {
  applyAvailableAddProjectHosts,
  backAddProjectPage,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectSelection,
  openAddProjectFlow,
  openDirectorySearchPage,
  openGithubLocationPage,
  openGithubSearchPage,
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
  buildAddProjectMethods,
  addProjectMethodEmptyText,
  buildExistingProjectChoices,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
  buildSuggestedParentDirectories,
  filterAddProjectHosts,
  joinDirectoryPath,
  pathBaseName,
  type AddProjectMethodId,
} from "@/add-project-flow/options";
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
  useHosts,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useHostProjects } from "@/projects/host-projects";
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
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={styles.backButton}
      accessibilityRole="button"
      accessibilityLabel={t("addProjectFlow.accessibility.back")}
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

function methodIcon(method: AddProjectMethodId): FlowRowOption["icon"] {
  if (method === "github") return Github;
  if (method === "browse") return FolderOpen;
  if (method === "new-directory") return FolderPlus;
  return Search;
}

function directoryOptionSubtitle(option: ProjectPickerOption, shortPath: string): string | null {
  if (option.kind === "path") return i18n.t("addProjectFlow.rows.openThisPath");
  if (shortPath === option.path) return null;
  return option.path;
}

function progressText(page: AddProjectPage): string {
  if (page.kind === "github-location") return i18n.t("addProjectFlow.progress.cloning");
  if (page.kind === "new-directory-name") return i18n.t("addProjectFlow.progress.creating");
  return i18n.t("addProjectFlow.progress.adding");
}

function emptyText(page: AddProjectPage, host: AddProjectHost | null): string {
  if (page.kind === "host") return i18n.t("addProjectFlow.empty.noHosts");
  if (page.kind === "github-search") return i18n.t("addProjectFlow.empty.enterGithub");
  if (page.kind === "method") return addProjectMethodEmptyText(host);
  return i18n.t("addProjectFlow.empty.noMatching");
}

interface QueryErrorInput {
  searchesDirectories: boolean;
  directoryFailed: boolean;
  githubFailed: boolean;
  githubAvailable: boolean | null;
  githubError: string | null;
}

function queryErrorText(input: QueryErrorInput): string | null {
  if (input.searchesDirectories && input.directoryFailed) {
    return i18n.t("addProjectFlow.errors.unableToSearchDirectories");
  }
  if (input.githubFailed) return i18n.t("addProjectFlow.errors.unableToSearchGithub");
  if (input.githubError) return input.githubError;
  if (input.githubAvailable === false) {
    return input.githubError ?? i18n.t("addProjectFlow.errors.githubUnavailable");
  }
  return null;
}

function pageHostId(page: AddProjectPage): string | null {
  return page.kind === "host" ? null : page.hostId;
}

function pageTitle(page: AddProjectPage): string {
  switch (page.kind) {
    case "host":
      return i18n.t("addProjectFlow.titles.chooseHost");
    case "method":
      return i18n.t("addProjectFlow.titles.addProject");
    case "directory-search":
      return i18n.t("addProjectFlow.titles.searchDirectory");
    case "github-search":
      return i18n.t("addProjectFlow.titles.cloneGithub");
    case "github-location":
      return i18n.t("addProjectFlow.titles.chooseDestination");
    case "new-directory-parent":
      return i18n.t("addProjectFlow.titles.chooseParent");
    case "new-directory-name":
      return i18n.t("addProjectFlow.titles.nameDirectory");
  }
}

function pagePlaceholder(page: AddProjectPage): string {
  switch (page.kind) {
    case "host":
      return i18n.t("addProjectFlow.placeholders.searchHosts");
    case "method":
      return i18n.t("addProjectFlow.placeholders.searchMethods");
    case "directory-search":
      return i18n.t("addProjectFlow.placeholders.searchDirectories");
    case "github-search":
      return i18n.t("addProjectFlow.placeholders.searchGithub");
    case "github-location":
    case "new-directory-parent":
      return i18n.t("addProjectFlow.placeholders.searchParents");
    case "new-directory-name":
      return i18n.t("addProjectFlow.placeholders.directoryName");
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
  const { t } = useTranslation();
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
  const projectHostIds = useMemo(() => (hostId ? [hostId] : []), [hostId]);
  const existingProjects = useHostProjects(projectHostIds);
  const openProject = useOpenProject(hostId);
  const cloneGithubProject = useCloneGithubProject(hostId);
  const addEmptyProject = useSessionStore((store) => store.addEmptyProject);
  const setHasHydratedWorkspaces = useSessionStore((store) => store.setHasHydratedWorkspaces);
  const inputRef = useRef<TextInput>(null);
  const submissionInFlightRef = useRef(false);
  const browseInFlightRef = useRef(false);
  const query = page.kind === "new-directory-name" ? "" : page.query;
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    setState((current) =>
      applyAvailableAddProjectHosts(current, availableHosts, request.preferredHostId),
    );
  }, [availableHosts, request.preferredHostId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [page.kind]);

  const searchesDirectories =
    page.kind === "directory-search" ||
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
    queryKey: ["add-project-flow-github", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("addProjectFlow.errors.hostUnavailable"));
      const payload = await client.searchGithubRepositories({ query: debouncedQuery, limit: 30 });
      return { query: debouncedQuery, payload };
    },
    enabled: Boolean(client && page.kind === "github-search" && host?.canSearchGithubRepositories),
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
    async (path: string, sourceKind: "directory-search" | "method") => {
      if (!hostId || submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      setState((current) =>
        setPageStatus(current, sourceKind, { isSubmitting: true, error: null }),
      );
      try {
        const result = await openProject(path);
        if (result.ok) {
          openNewWorkspaceForProject(hostId, result.project);
          return;
        }
        const reason = getOpenProjectFailureReason(result);
        const message =
          reason === "directory_not_found"
            ? i18n.t("addProjectFlow.errors.directoryNotFound")
            : i18n.t("addProjectFlow.errors.unableToAdd");
        setState((current) =>
          setPageStatus(current, sourceKind, { isSubmitting: false, error: message }),
        );
      } catch {
        setState((current) =>
          setPageStatus(current, sourceKind, {
            isSubmitting: false,
            error: i18n.t("addProjectFlow.errors.unableToAdd"),
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
      if (path) await openAddedProject(path, "method");
    } catch {
      setState((current) =>
        setPageStatus(current, "method", {
          error: i18n.t("addProjectFlow.errors.unableToBrowse"),
        }),
      );
    } finally {
      browseInFlightRef.current = false;
    }
  }, [hostId, isLocalDaemon, openAddedProject]);

  const selectMethod = useCallback(
    (method: AddProjectMethodId) => {
      if (!hostId) return;
      if (method === "directory-search") {
        setState((current) => openDirectorySearchPage(current, hostId));
      } else if (method === "browse") {
        void browse();
      } else if (method === "github") {
        setState((current) => openGithubSearchPage(current, hostId));
      } else {
        setState((current) => openNewDirectoryParentPage(current, hostId));
      }
    },
    [browse, hostId],
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
  const existingProjectChoices = useMemo(
    () =>
      page.kind === "directory-search" && hostId
        ? buildExistingProjectChoices({
            projects: existingProjects,
            serverId: hostId,
            query,
          })
        : [],
    [existingProjects, hostId, page.kind, query],
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
            error: result.error ?? i18n.t("addProjectFlow.errors.unableToClone"),
          }),
        );
      } catch (error) {
        setState((current) =>
          setPageStatus(current, "github-location", {
            isSubmitting: false,
            error:
              error instanceof Error
                ? error.message
                : i18n.t("addProjectFlow.errors.unableToClone"),
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
          title: t("addProjectFlow.rows.addHost"),
          subtitle: t("addProjectFlow.empty.noHosts"),
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
    if (page.kind === "method") {
      if (!host) return [];
      const normalized = page.query.trim().toLowerCase();
      return buildAddProjectMethods(host)
        .filter(
          (method) =>
            !normalized ||
            method.label.toLowerCase().includes(normalized) ||
            method.description.toLowerCase().includes(normalized),
        )
        .map((method) => ({
          id: method.id,
          title: method.label,
          subtitle: method.description,
          icon: methodIcon(method.id),
          disabled: method.disabled,
          testID: `add-project-flow-method-${method.id}`,
          select: () => selectMethod(method.id),
        }));
    }
    if (page.kind === "directory-search") {
      const existingSourceDirectories = new Set(
        existingProjectChoices.map((choice) => choice.sourceDirectory),
      );
      const existingRows = existingProjectChoices.map((choice) => ({
        id: `existing-project:${choice.project.projectKey}`,
        title: choice.project.projectName,
        subtitle: t("addProjectFlow.rows.existingProject", {
          path: shortenPath(choice.sourceDirectory),
        }),
        icon: FolderOpen,
        testID: `add-project-flow-existing-project-${choice.project.projectKey}`,
        select: () =>
          openNewWorkspaceForProject(page.hostId, {
            projectId: choice.project.projectKey,
            projectRootPath: choice.sourceDirectory,
            projectDisplayName: choice.project.projectName,
            projectKind: choice.project.projectKind,
          }),
      }));
      const directoryRows = pathOptions
        .filter((option) => !existingSourceDirectories.has(option.path))
        .map((option) => {
          const shortPath = shortenPath(option.path);
          return {
            id: option.path,
            title: shortPath,
            subtitle: directoryOptionSubtitle(option, shortPath),
            icon: Folder,
            testID: pathTestId(option.path),
            select: () => void openAddedProject(option.path, "directory-search"),
          };
        });
      return [...existingRows, ...directoryRows];
    }
    if (page.kind === "github-search") {
      const search = githubQuery.data?.query === page.query ? githubQuery.data.payload : null;
      const repositories = search?.repositories ?? [];
      const normalizedQuery = page.query.trim().toLowerCase();
      const hasExactSearchResult = repositories.some(
        (repository) =>
          repository.nameWithOwner.toLowerCase() === normalizedQuery ||
          repository.cloneUrl.toLowerCase() === normalizedQuery,
      );
      const manualRepositories = hasExactSearchResult
        ? []
        : buildManualGithubRepositoryChoices(page.query);
      const repositoryChoices: GithubRepositoryChoice[] = [...manualRepositories, ...repositories];
      return repositoryChoices.map((repository) => ({
        id: repository.id,
        title: repository.cloneProtocol
          ? t("addProjectFlow.rows.viaProtocol", {
              name: repository.nameWithOwner,
              protocol: repository.cloneProtocol.toUpperCase(),
            })
          : repository.nameWithOwner,
        subtitle: repository.description ?? repository.visibility,
        icon: Github,
        testID: `add-project-flow-repository-${repository.id}`,
        select: () =>
          setState((current) => openGithubLocationPage(current, page.hostId, repository)),
      }));
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
        subtitle: option.kind === "path" ? t("addProjectFlow.rows.useThisParent") : option.path,
        icon: Folder,
        testID: pathTestId(option.path),
        select: () =>
          setState((current) => openNewDirectoryNamePage(current, page.hostId, option.path)),
      }));
    }
    return [];
  }, [
    cloneRepository,
    directoryPaths,
    existingProjectChoices,
    githubQuery.data,
    host,
    onClose,
    openAddedProject,
    openNewWorkspaceForProject,
    page,
    pathOptions,
    recommendedPaths,
    selectMethod,
    state.hosts,
    t,
  ]);

  const activeIndex = rows.length === 0 ? 0 : Math.min(page.activeIndex, rows.length - 1);
  const createDirectory = useCallback(async () => {
    if (page.kind !== "new-directory-name" || !client) return;
    const name = page.name.trim();
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      setState((current) =>
        setPageStatus(current, "new-directory-name", {
          error: i18n.t("addProjectFlow.errors.enterDirectoryName"),
        }),
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
            error: payload.error ?? i18n.t("addProjectFlow.errors.unableToCreateDirectory"),
          }),
        );
        return;
      }
      registerProjectDescriptor({
        serverId: page.hostId,
        project: payload.project,
        addEmptyProject,
        setHasHydratedWorkspaces,
      });
      openNewWorkspaceForProject(page.hostId, payload.project);
    } catch {
      setState((current) =>
        setPageStatus(current, "new-directory-name", {
          isSubmitting: false,
          error: i18n.t("addProjectFlow.errors.unableToCreateDirectory"),
        }),
      );
    } finally {
      submissionInFlightRef.current = false;
    }
  }, [addEmptyProject, client, openNewWorkspaceForProject, page, setHasHydratedWorkspaces]);

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
      if (key !== "ArrowDown" && key !== "ArrowUp") return false;
      const next = moveAddProjectSelection(
        activeIndex,
        rows.map((row) => row.disabled !== true),
        key === "ArrowDown" ? "next" : "previous",
      );
      setState((current) => setAddProjectActiveIndex(current, next));
      return true;
    },
    [activeIndex, handleBack, rows, submitActive],
  );

  useEffect(() => {
    if (!isWeb || typeof window === "undefined") return;
    const listener = (event: KeyboardEvent) => {
      if (handleKey(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [handleKey]);

  const handleNativeKeyPress = useCallback(
    ({ nativeEvent: { key } }: { nativeEvent: { key: string } }) => {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Escape") {
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
    page.kind === "github-search" && githubQuery.data?.query === page.query
      ? githubQuery.data.payload
      : null;
  const loading =
    (searchesDirectories && (query !== debouncedQuery || directoryQuery.isFetching)) ||
    (page.kind === "github-search" &&
      host?.canSearchGithubRepositories === true &&
      (query !== debouncedQuery || githubQuery.isFetching));
  const queryError = queryErrorText({
    searchesDirectories,
    directoryFailed: directoryQuery.isError,
    githubFailed: page.kind === "github-search" && githubQuery.isError,
    githubAvailable: currentGithubSearch?.available ?? null,
    githubError: currentGithubSearch?.error ?? null,
  });
  const preview =
    page.kind === "new-directory-name" && page.name.trim()
      ? joinDirectoryPath(page.parentPath, page.name.trim())
      : null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={isWeb ? undefined : handleBack}>
      <View style={styles.overlay} testID="add-project-flow">
        <Pressable style={styles.backdrop} onPress={onClose} testID="add-project-flow-backdrop" />
        <View
          style={styles.panel}
          testID={`add-project-flow-page-${page.kind}`}
          accessibilityLabel={t("addProjectFlow.accessibility.page", { kind: page.kind })}
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
                {t("addProjectFlow.progress.loading")}
              </Text>
            ) : null}
            {!isSubmitting &&
            (!loading || page.kind === "github-search") &&
            (!queryError || page.kind === "github-search")
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
            <FlowHint keys={NAVIGATION_HINT_KEYS} action={t("addProjectFlow.hints.navigate")} />
            <FlowHint keys={SELECT_HINT_KEYS} action={t("addProjectFlow.hints.select")} />
            <FlowHint
              keys={ESCAPE_HINT_KEYS}
              action={
                state.pages.length > 1
                  ? t("addProjectFlow.hints.back")
                  : t("addProjectFlow.hints.close")
              }
            />
          </View>
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
