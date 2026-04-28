/**
 * AddProjectModal — Professional multi-step modal for adding projects.
 *
 * Three flows:
 *  1. Open Folder — pick an existing directory (local) or type a path (remote)
 *  2. Create New — scaffold a new project with optional git init
 *  3. Clone — clone a GitHub/GitLab/etc repository
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { createPortal } from "react-dom";
import {
  FolderOpen,
  FolderPlus,
  GitBranch,
  ArrowLeft,
  ChevronRight,
  AlertCircle,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useOpenProject } from "@/hooks/use-open-project";
import { useActiveOrgId } from "@/stores/active-org-store";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { pickDirectory } from "@/desktop/pick-directory";
import { parseServerIdFromPathname } from "@/utils/host-routes";
import { usePathname } from "expo-router";
import { isWeb, isNative } from "@/constants/platform";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { router } from "expo-router";
import { useToast } from "@/contexts/toast-context";
import { useQuery } from "@tanstack/react-query";
import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";
import { shortenPath } from "@/utils/shorten-path";

// ─── Types ───────────────────────────────────────────────────────────────────

type FlowKind = "open" | "create" | "clone";
type Step = "pick" | "form" | "loading" | "error";

interface OptionCardDef {
  kind: FlowKind;
  icon: ReactNode;
  title: string;
  description: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AddProjectModal() {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const daemons = useHosts();
  const toast = useToast();

  const open = useKeyboardShortcutsStore((s) => s.addProjectModalOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setAddProjectModalOpen);

  const serverId = useMemo(() => {
    const fromPath = parseServerIdFromPathname(pathname);
    if (fromPath) return fromPath;
    return daemons[0]?.serverId ?? null;
  }, [pathname, daemons]);

  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isLocalDaemon = useIsLocalDaemon(serverId ?? "");
  const openProject = useOpenProject(serverId);
  const activeOrgId = useActiveOrgId();
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  // ── State ────────────────────────────────────────────────────────────────

  const [step, setStep] = useState<Step>("pick");
  const [flow, setFlow] = useState<FlowKind | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Create New form
  const [projectName, setProjectName] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [gitInit, setGitInit] = useState(true);

  // Clone form
  const [repoUrl, setRepoUrl] = useState("");
  const [cloneDir, setCloneDir] = useState("");

  // Open folder (remote) form
  const [openPath, setOpenPath] = useState("");
  const [openActiveIndex, setOpenActiveIndex] = useState(0);

  const projectNameRef = useRef<TextInput>(null);
  const repoUrlRef = useRef<TextInput>(null);
  const openPathRef = useRef<TextInput>(null);

  // ── Directory suggestions for remote "Open Folder" ───────────────────────

  const workspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );

  const recommendedPaths = useMemo(() => {
    if (!workspaces) return [];
    return Array.from(workspaces.values()).map((w) => w.projectRootPath || w.id);
  }, [workspaces]);

  const directorySuggestionsQuery = useQuery({
    queryKey: ["add-project-dir-suggestions", serverId, openPath],
    queryFn: async () => {
      if (!client) return [];
      const result = await client.getDirectorySuggestions({
        query: openPath,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return (
        result.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ?? []
      );
    },
    enabled: Boolean(client) && isConnected && open && flow === "open",
    staleTime: 15_000,
    retry: false,
  });

  const openOptions = useMemo(
    () =>
      buildWorkingDirectorySuggestions({
        recommendedPaths,
        serverPaths: directorySuggestionsQuery.data ?? [],
        query: openPath,
      }),
    [openPath, directorySuggestionsQuery.data, recommendedPaths],
  );

  // ── Reset on open/close ──────────────────────────────────────────────────

  useEffect(() => {
    if (open) {
      setStep("pick");
      setFlow(null);
      setIsSubmitting(false);
      setErrorMessage(null);
      setProjectName("");
      setParentDir("");
      setGitInit(true);
      setRepoUrl("");
      setCloneDir("");
      setOpenPath("");
      setOpenActiveIndex(0);
    }
  }, [open]);

  // Auto-focus inputs when entering form steps
  useEffect(() => {
    if (step !== "form") return;
    const id = setTimeout(() => {
      if (flow === "create") projectNameRef.current?.focus();
      if (flow === "clone") repoUrlRef.current?.focus();
      if (flow === "open") openPathRef.current?.focus();
    }, 100);
    return () => clearTimeout(id);
  }, [step, flow]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelectFlow = useCallback(
    async (kind: FlowKind) => {
      if (kind === "open" && isLocalDaemon) {
        // Local daemon: use native file picker directly
        try {
          const path = await pickDirectory();
          if (path === null) return;
          setFlow("open");
          setStep("loading");
          setIsSubmitting(true);
          const success = await openProject(path);
          if (success) {
            handleClose();
          } else {
            setStep("error");
            setErrorMessage("Failed to open project");
          }
        } catch (err) {
          setStep("error");
          setErrorMessage(err instanceof Error ? err.message : "Failed to open project");
        } finally {
          setIsSubmitting(false);
        }
        return;
      }

      setFlow(kind);
      setStep("form");
    },
    [handleClose, isLocalDaemon, openProject],
  );

  const handleBack = useCallback(() => {
    setStep("pick");
    setFlow(null);
    setErrorMessage(null);
  }, []);

  const handleBrowseParentDir = useCallback(async () => {
    if (!isLocalDaemon) return;
    try {
      const path = await pickDirectory();
      if (path) setParentDir(path);
    } catch {
      // Cancelled
    }
  }, [isLocalDaemon]);

  const handleBrowseCloneDir = useCallback(async () => {
    if (!isLocalDaemon) return;
    try {
      const path = await pickDirectory();
      if (path) setCloneDir(path);
    } catch {
      // Cancelled
    }
  }, [isLocalDaemon]);

  // ── Create New ───────────────────────────────────────────────────────────

  const handleCreateProject = useCallback(async () => {
    const name = projectName.trim();
    const parent = parentDir.trim();
    if (!name || !parent || !client || !serverId) return;

    setStep("loading");
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const fullPath = `${parent}/${name}`;
      const initCmd = gitInit
        ? `mkdir -p '${fullPath}' && cd '${fullPath}' && git init`
        : `mkdir -p '${fullPath}'`;

      const terminalResult = await client.createCliAgentTerminal({
        cwd: parent,
        command: "sh",
        args: ["-c", initCmd],
        name: `Create: ${name}`,
      });

      if (terminalResult.error) {
        throw new Error(terminalResult.error);
      }

      // mkdir + git init is near-instant. Wait briefly for FS to settle.
      await delay(1500);

      const payload = await client.openProject(fullPath, {
        orgId: activeOrgId ?? undefined,
      });
      if (payload.error || !payload.workspace) {
        throw new Error(payload.error || "Failed to register project");
      }

      mergeWorkspaces(serverId, [normalizeWorkspaceDescriptor(payload.workspace)]);
      setHasHydratedWorkspaces(serverId, true);

      handleClose();

      router.replace(
        prepareWorkspaceTab({
          serverId,
          workspaceId: payload.workspace.id,
          target: { kind: "draft", draftId: "new" },
        }) as any,
      );
    } catch (err) {
      setStep("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    client,
    gitInit,
    handleClose,
    mergeWorkspaces,
    parentDir,
    projectName,
    serverId,
    setHasHydratedWorkspaces,
  ]);

  // ── Clone ────────────────────────────────────────────────────────────────

  const inferredRepoName = useMemo(() => {
    const url = repoUrl.trim();
    if (!url) return "";
    // Handle GitHub URLs, git@ URLs, etc.
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] ?? "";
  }, [repoUrl]);

  const handleCloneProject = useCallback(async () => {
    const url = repoUrl.trim();
    const dest = cloneDir.trim();
    const repoName = inferredRepoName;
    if (!url || !dest || !repoName || !client || !serverId) return;

    setStep("loading");
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const fullPath = `${dest}/${repoName}`;

      // Create terminal with git clone — shows progress
      const terminalResult = await client.createCliAgentTerminal({
        cwd: dest,
        command: "git",
        args: ["clone", url, fullPath],
        name: `Clone: ${repoName}`,
      });

      if (terminalResult.error) {
        throw new Error(terminalResult.error);
      }

      // Poll for clone completion: try openProject every 3s up to 5 minutes
      const maxAttempts = 100;
      const pollInterval = 3000;
      let workspace = null;

      for (let i = 0; i < maxAttempts; i++) {
        await delay(pollInterval);
        try {
          const payload = await client.openProject(fullPath, {
            orgId: activeOrgId ?? undefined,
          });
          if (payload.workspace) {
            workspace = payload.workspace;
            break;
          }
        } catch {
          // Directory doesn't exist yet — keep polling
        }
      }

      if (!workspace) {
        throw new Error("Clone is taking longer than expected. Check the terminal for progress.");
      }

      mergeWorkspaces(serverId, [normalizeWorkspaceDescriptor(workspace)]);
      setHasHydratedWorkspaces(serverId, true);

      handleClose();

      router.replace(
        prepareWorkspaceTab({
          serverId,
          workspaceId: workspace.id,
          target: { kind: "draft", draftId: "new" },
        }) as any,
      );
    } catch (err) {
      setStep("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to clone repository");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    client,
    cloneDir,
    handleClose,
    inferredRepoName,
    mergeWorkspaces,
    repoUrl,
    serverId,
    setHasHydratedWorkspaces,
  ]);

  // ── Open Folder (remote) ────────────────────────────────────────────────

  const handleOpenRemotePath = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return;

      setStep("loading");
      setIsSubmitting(true);
      setErrorMessage(null);

      try {
        const success = await openProject(trimmed);
        if (success) {
          handleClose();
        } else {
          setStep("error");
          setErrorMessage("Failed to open project");
        }
      } catch (err) {
        setStep("error");
        setErrorMessage(err instanceof Error ? err.message : "Failed to open project");
      } finally {
        setIsSubmitting(false);
      }
    },
    [handleClose, openProject],
  );

  // ── Keyboard ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open || isNative) return;

    function handler(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (step === "form") {
          handleBack();
        } else {
          handleClose();
        }
        return;
      }

      // Enter on forms
      if (event.key === "Enter" && step === "form") {
        event.preventDefault();
        if (flow === "create") handleCreateProject();
        if (flow === "clone") handleCloneProject();
        if (flow === "open") {
          const selected =
            openOptions.length > 0 && openActiveIndex < openOptions.length
              ? openOptions[openActiveIndex]!
              : openPath.trim();
          if (selected) void handleOpenRemotePath(selected);
        }
        return;
      }

      // Arrow navigation for open folder
      if (flow === "open" && step === "form") {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (openOptions.length === 0) return;
          event.preventDefault();
          setOpenActiveIndex((current) => {
            const delta = event.key === "ArrowDown" ? 1 : -1;
            const next = current + delta;
            if (next < 0) return openOptions.length - 1;
            if (next >= openOptions.length) return 0;
            return next;
          });
        }
      }
    }

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    flow,
    handleBack,
    handleClose,
    handleCloneProject,
    handleCreateProject,
    handleOpenRemotePath,
    open,
    openActiveIndex,
    openOptions,
    openPath,
    step,
  ]);

  // ── Option cards ─────────────────────────────────────────────────────────

  const optionCards: OptionCardDef[] = useMemo(
    () => [
      {
        kind: "open" as FlowKind,
        icon: <FolderOpen size={24} color={theme.colors.accent} strokeWidth={1.8} />,
        title: "Open Folder",
        description: "Open an existing project from your machine",
      },
      {
        kind: "create" as FlowKind,
        icon: <FolderPlus size={24} color={theme.colors.accent} strokeWidth={1.8} />,
        title: "Create New",
        description: "Start a fresh project from scratch",
      },
      {
        kind: "clone" as FlowKind,
        icon: <GitBranch size={24} color={theme.colors.accent} strokeWidth={1.8} />,
        title: "Clone Repository",
        description: "Clone a Git repository by URL",
      },
    ],
    [theme.colors.accent],
  );

  // ── Validation ───────────────────────────────────────────────────────────

  const createValid = projectName.trim().length > 0 && parentDir.trim().length > 0;
  const cloneValid =
    repoUrl.trim().length > 0 && cloneDir.trim().length > 0 && inferredRepoName.length > 0;

  // ── Render helpers ───────────────────────────────────────────────────────

  if (!serverId) return null;

  const renderOptionCards = () => (
    <View style={styles.cardsContainer}>
      {optionCards.map((card) => (
        <Pressable
          key={card.kind}
          style={({ hovered, pressed }) => [
            styles.card,
            (hovered || pressed) && styles.cardHovered,
          ]}
          onPress={() => void handleSelectFlow(card.kind)}
        >
          <View style={styles.cardIconContainer}>{card.icon}</View>
          <View style={styles.cardTextContainer}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>{card.title}</Text>
              <ChevronRight size={16} color={theme.colors.foregroundMuted} strokeWidth={2} />
            </View>
            <Text style={styles.cardDescription}>{card.description}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );

  const renderCreateForm = () => (
    <View style={styles.formContainer}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Project name</Text>
        <TextInput
          ref={projectNameRef}
          value={projectName}
          onChangeText={setProjectName}
          placeholder="my-awesome-project"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Parent directory</Text>
        <View style={styles.inputRow}>
          <TextInput
            value={parentDir}
            onChangeText={setParentDir}
            placeholder={isLocalDaemon ? "/Users/you/projects" : "~/projects"}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.input, styles.inputFlex]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {isLocalDaemon && (
            <Pressable
              style={({ hovered }) => [styles.browseButton, hovered && styles.browseButtonHovered]}
              onPress={handleBrowseParentDir}
            >
              <Text style={styles.browseButtonText}>Browse</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.switchRow}>
        <View style={styles.switchTextContainer}>
          <Text style={styles.switchLabel}>Initialize Git repository</Text>
          <Text style={styles.switchHint}>Creates an initial Git repository in the project</Text>
        </View>
        <Switch
          value={gitInit}
          onValueChange={setGitInit}
          trackColor={{
            false: theme.colors.surface3,
            true: theme.colors.accent,
          }}
          thumbColor={theme.colors.foreground}
        />
      </View>

      {projectName.trim() && parentDir.trim() ? (
        <View style={styles.previewRow}>
          <Text style={styles.previewLabel}>Will create:</Text>
          <Text style={styles.previewPath}>
            {parentDir.trim()}/{projectName.trim()}
          </Text>
        </View>
      ) : null}

      <Pressable
        style={({ hovered, pressed }) => [
          styles.primaryButton,
          !createValid && styles.primaryButtonDisabled,
          createValid && hovered && styles.primaryButtonHovered,
          createValid && pressed && styles.primaryButtonPressed,
        ]}
        onPress={handleCreateProject}
        disabled={!createValid}
      >
        <FolderPlus
          size={16}
          color={createValid ? "#fff" : theme.colors.foregroundMuted}
          strokeWidth={2}
        />
        <Text style={[styles.primaryButtonText, !createValid && styles.primaryButtonTextDisabled]}>
          Create Project
        </Text>
      </Pressable>
    </View>
  );

  const renderCloneForm = () => (
    <View style={styles.formContainer}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Repository URL</Text>
        <TextInput
          ref={repoUrlRef}
          value={repoUrl}
          onChangeText={setRepoUrl}
          placeholder="https://github.com/owner/repo"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {inferredRepoName ? (
          <Text style={styles.fieldHint}>Repository: {inferredRepoName}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Destination directory</Text>
        <View style={styles.inputRow}>
          <TextInput
            value={cloneDir}
            onChangeText={setCloneDir}
            placeholder={isLocalDaemon ? "/Users/you/projects" : "~/projects"}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.input, styles.inputFlex]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {isLocalDaemon && (
            <Pressable
              style={({ hovered }) => [styles.browseButton, hovered && styles.browseButtonHovered]}
              onPress={handleBrowseCloneDir}
            >
              <Text style={styles.browseButtonText}>Browse</Text>
            </Pressable>
          )}
        </View>
      </View>

      {inferredRepoName && cloneDir.trim() ? (
        <View style={styles.previewRow}>
          <Text style={styles.previewLabel}>Will clone to:</Text>
          <Text style={styles.previewPath}>
            {cloneDir.trim()}/{inferredRepoName}
          </Text>
        </View>
      ) : null}

      <Pressable
        style={({ hovered, pressed }) => [
          styles.primaryButton,
          !cloneValid && styles.primaryButtonDisabled,
          cloneValid && hovered && styles.primaryButtonHovered,
          cloneValid && pressed && styles.primaryButtonPressed,
        ]}
        onPress={handleCloneProject}
        disabled={!cloneValid}
      >
        <GitBranch
          size={16}
          color={cloneValid ? "#fff" : theme.colors.foregroundMuted}
          strokeWidth={2}
        />
        <Text style={[styles.primaryButtonText, !cloneValid && styles.primaryButtonTextDisabled]}>
          Clone Repository
        </Text>
      </Pressable>
    </View>
  );

  const renderOpenForm = () => (
    <View style={styles.formContainer}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Directory path</Text>
        <TextInput
          ref={openPathRef}
          value={openPath}
          onChangeText={(text) => {
            setOpenPath(text);
            setOpenActiveIndex(0);
          }}
          placeholder="Type a directory path..."
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <ScrollView
        style={styles.openResults}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        {openOptions.length === 0 && !openPath.trim() ? (
          <Text style={styles.openEmptyText}>Start typing a path</Text>
        ) : (
          openOptions.map((path, index) => {
            const active = index === openActiveIndex;
            return (
              <Pressable
                key={path}
                style={({ hovered, pressed }) => [
                  styles.openRow,
                  (hovered || pressed || active) && styles.openRowActive,
                ]}
                onPress={() => void handleOpenRemotePath(path)}
              >
                <FolderOpen size={14} strokeWidth={2} color={theme.colors.foregroundMuted} />
                <Text style={styles.openRowText} numberOfLines={1}>
                  {shortenPath(path)}
                </Text>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  const renderLoading = () => (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color={theme.colors.accent} />
      <Text style={styles.loadingTitle}>
        {flow === "clone"
          ? "Cloning repository..."
          : flow === "create"
            ? "Creating project..."
            : "Opening project..."}
      </Text>
      <Text style={styles.loadingHint}>
        {flow === "clone"
          ? "This may take a few minutes for large repositories"
          : "Setting up your workspace"}
      </Text>
    </View>
  );

  const renderError = () => (
    <View style={styles.errorContainer}>
      <View style={styles.errorIconContainer}>
        <AlertCircle size={32} color={theme.colors.destructive} strokeWidth={1.8} />
      </View>
      <Text style={styles.errorTitle}>Something went wrong</Text>
      <Text style={styles.errorMessage}>{errorMessage}</Text>
      <Pressable
        style={({ hovered }) => [styles.retryButton, hovered && styles.retryButtonHovered]}
        onPress={handleBack}
      >
        <Text style={styles.retryButtonText}>Try Again</Text>
      </Pressable>
    </View>
  );

  const stepTitle =
    step === "pick"
      ? "Add Project"
      : flow === "open"
        ? "Open Folder"
        : flow === "create"
          ? "Create New Project"
          : flow === "clone"
            ? "Clone Repository"
            : "Add Project";

  const content = (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={handleClose} />

      <View style={styles.panel}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {step === "form" && (
              <Pressable
                style={({ hovered }) => [styles.backButton, hovered && styles.backButtonHovered]}
                onPress={handleBack}
              >
                <ArrowLeft size={16} color={theme.colors.foreground} strokeWidth={2} />
              </Pressable>
            )}
            <Text style={styles.title}>{stepTitle}</Text>
          </View>
        </View>

        {/* Body */}
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {step === "pick" && renderOptionCards()}
          {step === "form" && flow === "create" && renderCreateForm()}
          {step === "form" && flow === "clone" && renderCloneForm()}
          {step === "form" && flow === "open" && renderOpenForm()}
          {step === "loading" && renderLoading()}
          {step === "error" && renderError()}
        </ScrollView>
      </View>
    </View>
  );

  // Portal for web
  if (isWeb && typeof document !== "undefined") {
    if (!open) return null;
    return createPortal(content, getOverlayRoot());
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={open}
      onRequestClose={handleClose}
      hardwareAccelerated
    >
      {content}
    </Modal>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create((theme) => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    zIndex: OVERLAY_Z.modal,
    pointerEvents: "auto" as const,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
  },
  panel: {
    width: 520,
    maxWidth: "95%",
    maxHeight: "85%",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    overflow: "hidden",
    ...theme.shadow.lg,
  },

  // Header
  header: {
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  backButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  backButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },

  // Body
  body: {
    flexShrink: 1,
    minHeight: 0,
  },
  bodyContent: {
    padding: theme.spacing[6],
  },

  // Option cards
  cardsContainer: {
    gap: theme.spacing[3],
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  cardHovered: {
    borderColor: theme.colors.surface3,
    backgroundColor: theme.colors.surface2,
  },
  cardIconContainer: {
    width: 44,
    height: 44,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTextContainer: {
    flex: 1,
    minWidth: 0,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  cardDescription: {
    marginTop: 2,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },

  // Form
  formContainer: {
    gap: theme.spacing[4],
  },
  field: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  fieldHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  input: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    outlineStyle: "none",
  } as any,
  inputRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  inputFlex: {
    flex: 1,
    minWidth: 0,
  },
  browseButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  browseButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  browseButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },

  // Switch
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  switchTextContainer: {
    flex: 1,
    minWidth: 0,
    marginRight: theme.spacing[3],
  },
  switchLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  switchHint: {
    marginTop: 2,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },

  // Preview
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    borderStyle: "dashed",
  },
  previewLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  previewPath: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accent,
  },

  // Primary button
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
    marginTop: theme.spacing[2],
  },
  primaryButtonHovered: {
    backgroundColor: theme.colors.accentBright,
  },
  primaryButtonPressed: {
    opacity: 0.9,
  },
  primaryButtonDisabled: {
    backgroundColor: theme.colors.surface2,
  },
  primaryButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: "#ffffff",
  },
  primaryButtonTextDisabled: {
    color: theme.colors.foregroundMuted,
  },

  // Open folder (remote) results
  openResults: {
    maxHeight: 260,
  },
  openRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  openRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  openRowText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  openEmptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[3],
  },

  // Loading
  loadingContainer: {
    alignItems: "center",
    paddingVertical: theme.spacing[12],
    gap: theme.spacing[4],
  },
  loadingTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  loadingHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },

  // Error
  errorContainer: {
    alignItems: "center",
    paddingVertical: theme.spacing[8],
    gap: theme.spacing[3],
  },
  errorIconContainer: {
    width: 56,
    height: 56,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing[2],
  },
  errorTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  errorMessage: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 360,
  },
  retryButton: {
    marginTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  retryButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  retryButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
