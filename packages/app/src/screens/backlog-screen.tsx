import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  GestureResponderEvent,
  LayoutChangeEvent,
  NativeSyntheticEvent,
  PressableStateCallbackType,
  TextLayoutEventData,
  StyleProp,
  ViewStyle,
} from "react-native";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bold,
  Check,
  ChevronDown,
  Download,
  FileText,
  Folder,
  FolderPlus,
  ImageIcon,
  Italic,
  LayoutGrid,
  List,
  ListOrdered,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Video,
} from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TaskAttachment, TaskCard } from "@getpaseo/protocol/tasks/types";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useFetchQuery } from "@/data/query";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { TaskVideoPreview } from "@/components/tasks/task-video-preview";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useProjects } from "@/hooks/use-projects";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import {
  buildDownloadUrl,
  resolveDaemonDownloadTarget,
  useDownloadStore,
} from "@/stores/download-store";
import { useDraftStore } from "@/stores/draft-store";
import { generateDraftId } from "@/stores/draft-keys";
import type { UserComposerAttachment } from "@/attachments/types";
import type { PickedFile } from "@/attachments/picked-file";
import { toErrorMessage } from "@/utils/error-messages";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { buildNewWorkspaceDraftKey } from "@/utils/new-workspace-draft";
import { shortenPath } from "@/utils/shorten-path";
import { formatBacklogTaskWorkspacePrompt } from "@getpaseo/protocol/tasks/prompt";
import {
  annotateMasterBacklogTasks,
  buildMasterBacklogProjectTargets,
  fetchMasterBacklogTasks,
  filterBacklogTasksByQuery,
  sortMasterBacklogTasks,
  type MasterBacklogProjectTarget,
  type MasterBacklogTask,
} from "@/tasks/master-backlog";

const CARD_GAP = 12;
const MIN_GRID_CARD_WIDTH = 238;
const MAX_GRID_CARD_WIDTH = 320;
const GRID_CARD_ASPECT_RATIO = 16 / 10;
const LIST_CARD_HEIGHT = 148;
const CONTENT_PADDING = 20;
const TASKS_QUERY_KEY = "tasks.backlog";
const EMPTY_TASKS: TaskCard[] = [];
const LIST_CARD_STYLE = { height: LIST_CARD_HEIGHT } satisfies ViewStyle;

const scrollContentStyle = {
  padding: CONTENT_PADDING,
  paddingBottom: CONTENT_PADDING * 2,
} satisfies ViewStyle;

type BacklogViewMode = "grid" | "list";

interface BacklogScreenProps {
  serverId: string;
  projectId: string;
  displayName?: string;
}

interface AttachmentPreview {
  taskId: string;
  serverId?: string;
  projectId?: string;
  attachment: TaskAttachment;
  uri: string;
  kind: "image" | "video";
}

interface PendingPickedFile extends PickedFile {
  key: string;
}

interface CreateTaskInput {
  title: string;
  description: string;
  attachments: PickedFile[];
  target?: MasterBacklogProjectTarget;
}

function renderGridIcon({ color, size }: { color: string; size: number }) {
  return <LayoutGrid color={color} size={size} />;
}

function renderListIcon({ color, size }: { color: string; size: number }) {
  return <List color={color} size={size} />;
}

const VIEW_MODE_OPTIONS: SegmentedControlOption<BacklogViewMode>[] = [
  {
    value: "grid",
    label: "Grid",
    icon: renderGridIcon,
  },
  {
    value: "list",
    label: "List",
    icon: renderListIcon,
  },
];

export function BacklogScreen({ serverId, projectId, displayName }: BacklogScreenProps) {
  if (serverId && projectId) {
    return (
      <ProjectBacklogScreen serverId={serverId} projectId={projectId} displayName={displayName} />
    );
  }
  return <MasterBacklogScreen />;
}

function ProjectBacklogScreen({ serverId, projectId, displayName }: BacklogScreenProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const supportsBacklog = useHostFeature(serverId, "taskBacklog");
  const hosts = useHosts();
  const daemonProfile = useMemo(
    () => hosts.find((host) => host.serverId === serverId),
    [hosts, serverId],
  );
  const startDownload = useDownloadStore((state) => state.startDownload);
  const [viewMode, setViewMode] = useState<BacklogViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskCard | null>(null);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [creatingWorkspaceTaskId, setCreatingWorkspaceTaskId] = useState<string | null>(null);
  const [contentWidth, setContentWidth] = useState(0);

  const queryKey = useMemo(
    () => [TASKS_QUERY_KEY, serverId, projectId] as const,
    [serverId, projectId],
  );
  const tasksQuery = useFetchQuery({
    queryKey,
    enabled: Boolean(client && serverId && projectId && supportsBacklog),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listTasks(projectId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.tasks;
    },
    dataShape: "list",
    staleTimeMs: 0,
  });

  const tasks = tasksQuery.data ?? EMPTY_TASKS;
  const visibleTasks = useMemo(() => {
    const sorted = [...tasks].sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "active" ? -1 : 1;
      }
      return left.order - right.order || left.createdAt.localeCompare(right.createdAt);
    });
    return filterBacklogTasksByQuery(sorted, searchQuery);
  }, [searchQuery, tasks]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContentWidth(event.nativeEvent.layout.width);
  }, []);

  const cardWidth = useMemo(() => {
    if (contentWidth <= 0) {
      return MIN_GRID_CARD_WIDTH;
    }
    const columns = Math.max(
      1,
      Math.floor((contentWidth + CARD_GAP) / (MIN_GRID_CARD_WIDTH + CARD_GAP)),
    );
    const width = (contentWidth - CARD_GAP * (columns - 1)) / columns;
    return Math.min(MAX_GRID_CARD_WIDTH, Math.max(MIN_GRID_CARD_WIDTH, width));
  }, [contentWidth]);
  const gridCardStyle = useMemo(
    () => ({ width: cardWidth, aspectRatio: GRID_CARD_ASPECT_RATIO }),
    [cardWidth],
  );
  const taskCardStyle = viewMode === "grid" ? gridCardStyle : LIST_CARD_STYLE;

  const invalidateTasks = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const handleCreateTask = useCallback(
    async (input: { title: string; description: string; attachments: PickedFile[] }) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const uploaded = await Promise.all(
        input.attachments.map(async (attachment) => {
          const result = await client.uploadFile({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            bytes: attachment.bytes,
          });
          if (result.error || !result.file) {
            throw new Error(result.error ?? `Failed to upload ${attachment.fileName}`);
          }
          return result.file;
        }),
      );
      const payload = await client.createTask({
        projectId,
        title: input.title,
        description: input.description,
        attachments: uploaded,
      });
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "Failed to add task");
      }
      await invalidateTasks();
    },
    [client, invalidateTasks, projectId, t],
  );

  const handleUpdateTask = useCallback(
    async (
      taskId: string,
      input: { title?: string; description?: string; status?: TaskCard["status"] },
    ) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.updateTask({ projectId, taskId, ...input });
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "Failed to update task");
      }
      await invalidateTasks();
    },
    [client, invalidateTasks, projectId, t],
  );

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.deleteTask({ projectId, taskId });
      if (payload.error) {
        throw new Error(payload.error);
      }
      await invalidateTasks();
    },
    [client, invalidateTasks, projectId, t],
  );

  const requestAttachmentToken = useCallback(
    async (taskId: string, attachment: TaskAttachment) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const token = await client.requestTaskAttachmentDownloadToken({
        projectId,
        taskId,
        attachmentId: attachment.id,
      });
      if (token.error || !token.token) {
        throw new Error(token.error ?? "Failed to open attachment");
      }
      return token;
    },
    [client, projectId, t],
  );

  const buildAttachmentUri = useCallback(
    (token: string) => {
      const target = resolveDaemonDownloadTarget(daemonProfile);
      if (!target.baseUrl) {
        throw new Error("Host download URL is not available");
      }
      return buildDownloadUrl(target.baseUrl, token, isWeb ? target.authCredentials : null);
    },
    [daemonProfile],
  );

  const handleAttachmentPress = useCallback(
    async (task: TaskCard, attachment: TaskAttachment) => {
      try {
        if (isRenderableAttachment(attachment)) {
          const token = await requestAttachmentToken(task.id, attachment);
          const downloadToken = token.token;
          if (!downloadToken) {
            throw new Error(token.error ?? "Failed to open attachment");
          }
          setPreview({
            taskId: task.id,
            serverId,
            projectId,
            attachment,
            uri: buildAttachmentUri(downloadToken),
            kind: attachment.mimeType.startsWith("video/") ? "video" : "image",
          });
          return;
        }

        await startDownload({
          serverId,
          scopeId: `task:${task.id}`,
          fileName: attachment.fileName,
          path: attachment.id,
          daemonProfile,
          requestFileDownloadToken: async () =>
            requestAttachmentToken(task.id, attachment).then((token) => ({
              token: token.token,
              fileName: token.fileName,
              mimeType: token.mimeType,
              error: token.error,
            })),
        });
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [
      buildAttachmentUri,
      daemonProfile,
      projectId,
      requestAttachmentToken,
      serverId,
      startDownload,
      toast,
    ],
  );

  const handleCreateWorkspaceFromTask = useCallback(
    async (task: TaskCard) => {
      if (!client) {
        toast.error(t("workspace.terminal.hostDisconnected"));
        return;
      }
      if (!serverId || !projectId) {
        toast.error("Backlog project is unavailable");
        return;
      }
      setCreatingWorkspaceTaskId(task.id);
      try {
        const draftId = generateDraftId();
        const attachments = await buildWorkspaceDraftAttachmentsFromTask({
          task,
          requestAttachmentToken,
        });
        useDraftStore.getState().saveDraftInput({
          draftKey: buildNewWorkspaceDraftKey({
            selectedServerId: serverId,
            selectedSourceDirectory: null,
            draftId,
          }),
          draft: {
            text: formatBacklogTaskWorkspacePrompt(task),
            attachments,
          },
        });
        router.navigate(
          buildNewWorkspaceRoute({
            serverId,
            projectId,
            displayName,
            draftId,
          }) as Href,
        );
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        setCreatingWorkspaceTaskId(null);
      }
    },
    [client, displayName, projectId, requestAttachmentToken, serverId, t, toast],
  );

  const handleToggleTaskStatus = useCallback(
    async (task: TaskCard) => {
      try {
        await handleUpdateTask(task.id, {
          status: task.status === "completed" ? "active" : "completed",
        });
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [handleUpdateTask, toast],
  );
  const handleOpenCreate = useCallback(() => {
    setIsCreateOpen(true);
  }, []);
  const handleCloseCreate = useCallback(() => {
    setIsCreateOpen(false);
  }, []);
  const handleCloseEdit = useCallback(() => {
    setEditingTask(null);
  }, []);
  const handleClosePreview = useCallback(() => {
    setPreview(null);
  }, []);
  const handleDownloadPreview = useCallback(() => {
    if (!preview) {
      return;
    }
    const task = tasks.find((entry) => entry.id === preview.taskId);
    if (!task) {
      return;
    }
    void handleAttachmentPress(task, {
      ...preview.attachment,
      mimeType: "application/octet-stream",
    });
  }, [handleAttachmentPress, preview, tasks]);

  const headerLeft = useMemo(
    () => (
      <>
        <SidebarMenuToggle />
        <ScreenTitle>Backlog</ScreenTitle>
      </>
    ),
    [],
  );

  const canUseBacklog = Boolean(serverId && projectId && supportsBacklog);
  const headerRight = useMemo(
    () =>
      canUseBacklog ? (
        <Button
          size="sm"
          variant="default"
          leftIcon={Plus}
          onPress={handleOpenCreate}
          testID="backlog-add-task"
        >
          Add
        </Button>
      ) : null,
    [canUseBacklog, handleOpenCreate],
  );
  const content = useMemo(() => {
    if (!serverId || !projectId) {
      return (
        <PanelMessage
          title="Backlog unavailable"
          message="Open a project backlog from the sidebar."
        />
      );
    }
    if (!supportsBacklog) {
      return <PanelMessage title="Update the host to use this." message={null} />;
    }
    if (tasksQuery.isLoading) {
      return <PanelMessage title="Loading..." message={null} />;
    }
    if (tasksQuery.error) {
      return (
        <PanelMessage title="Could not load tasks" message={toErrorMessage(tasksQuery.error)} />
      );
    }
    if (visibleTasks.length === 0) {
      return (
        <PanelMessage
          title={searchQuery.trim() ? "No matching tasks" : "No tasks"}
          message={searchQuery.trim() ? "Try a different search." : null}
        />
      );
    }
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={scrollContentStyle}>
        <View onLayout={handleLayout} style={viewMode === "grid" ? styles.grid : styles.list}>
          {visibleTasks.map((task) => (
            <TaskCardView
              key={task.id}
              task={task}
              mode={viewMode}
              cardStyle={taskCardStyle}
              onOpenTask={setEditingTask}
              onAttachmentPress={handleAttachmentPress}
              onCreateWorkspace={handleCreateWorkspaceFromTask}
              isCreatingWorkspace={creatingWorkspaceTaskId === task.id}
              onToggleStatus={handleToggleTaskStatus}
            />
          ))}
        </View>
      </ScrollView>
    );
  }, [
    handleAttachmentPress,
    handleCreateWorkspaceFromTask,
    handleLayout,
    handleToggleTaskStatus,
    creatingWorkspaceTaskId,
    projectId,
    searchQuery,
    serverId,
    supportsBacklog,
    taskCardStyle,
    tasksQuery.error,
    tasksQuery.isLoading,
    viewMode,
    visibleTasks,
  ]);
  const previewDownloadHandler = preview ? handleDownloadPreview : undefined;

  return (
    <View style={styles.screen}>
      <ScreenHeader left={headerLeft} borderless right={headerRight} />
      <View style={styles.contentShell}>
        <TitlebarDragRegion />
        <View style={styles.content}>
          <View style={styles.titleRow}>
            <View style={styles.titleGroup}>
              <Text style={styles.title}>Backlog</Text>
              {displayName ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {displayName}
                </Text>
              ) : null}
            </View>
            <SegmentedControl
              size="sm"
              value={viewMode}
              onValueChange={setViewMode}
              options={VIEW_MODE_OPTIONS}
            />
          </View>
          <BacklogSearchField value={searchQuery} onChangeText={setSearchQuery} />

          {content}
        </View>
      </View>

      <TaskFormSheet
        visible={isCreateOpen}
        projectName={displayName}
        onClose={handleCloseCreate}
        onCreate={handleCreateTask}
      />
      <TaskFormSheet
        visible={editingTask !== null}
        projectName={displayName}
        task={editingTask}
        onClose={handleCloseEdit}
        onUpdate={handleUpdateTask}
        onDelete={handleDeleteTask}
        onCreateWorkspace={handleCreateWorkspaceFromTask}
        isCreatingWorkspace={editingTask ? creatingWorkspaceTaskId === editingTask.id : false}
      />
      <TaskAttachmentPreviewSheet
        preview={preview}
        onClose={handleClosePreview}
        onDownload={previewDownloadHandler}
      />
    </View>
  );
}

function MasterBacklogScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const runtime = getHostRuntimeStore();
  const hosts = useHosts();
  const { projects } = useProjects();
  const startDownload = useDownloadStore((state) => state.startDownload);
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const allServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportsListAllByServerId = useHostFeatureMap(allServerIds, "taskBacklogListAll");
  const [viewMode, setViewMode] = useState<BacklogViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<MasterBacklogTask | null>(null);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [creatingWorkspaceTaskKey, setCreatingWorkspaceTaskKey] = useState<string | null>(null);
  const [contentWidth, setContentWidth] = useState(0);

  const hostProfileByServerId = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host] as const)),
    [hosts],
  );
  const supportedHosts = useMemo(
    () =>
      hosts
        .filter((host) => supportsListAllByServerId.get(host.serverId))
        .map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts, supportsListAllByServerId],
  );
  const supportedServerIds = useMemo(
    () => supportedHosts.map((host) => host.serverId),
    [supportedHosts],
  );
  const unsupportedHostCount = Math.max(0, hosts.length - supportedHosts.length);
  const projectTargets = useMemo(
    () =>
      buildMasterBacklogProjectTargets({
        projects,
        supportsBacklogByServerId: supportsListAllByServerId,
      }),
    [projects, supportsListAllByServerId],
  );

  const tasksQuery = useFetchQuery({
    queryKey: [TASKS_QUERY_KEY, "master", supportedServerIds.join("|"), runtimeVersion] as const,
    enabled: supportedHosts.length > 0,
    queryFn: () => fetchMasterBacklogTasks({ hosts: supportedHosts, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  const visibleTasks = useMemo(() => {
    const sorted = sortMasterBacklogTasks(
      annotateMasterBacklogTasks({
        hostTasks: tasksQuery.data?.hostTasks ?? [],
        projects,
      }),
    );
    return filterBacklogTasksByQuery(sorted, searchQuery);
  }, [projects, searchQuery, tasksQuery.data?.hostTasks]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContentWidth(event.nativeEvent.layout.width);
  }, []);

  const cardWidth = useMemo(() => {
    if (contentWidth <= 0) {
      return MIN_GRID_CARD_WIDTH;
    }
    const columns = Math.max(
      1,
      Math.floor((contentWidth + CARD_GAP) / (MIN_GRID_CARD_WIDTH + CARD_GAP)),
    );
    const width = (contentWidth - CARD_GAP * (columns - 1)) / columns;
    return Math.min(MAX_GRID_CARD_WIDTH, Math.max(MIN_GRID_CARD_WIDTH, width));
  }, [contentWidth]);
  const gridCardStyle = useMemo(
    () => ({ width: cardWidth, aspectRatio: GRID_CARD_ASPECT_RATIO }),
    [cardWidth],
  );
  const taskCardStyle = viewMode === "grid" ? gridCardStyle : LIST_CARD_STYLE;

  const invalidateTasks = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: [TASKS_QUERY_KEY] });
  }, [queryClient]);

  const requireClient = useCallback(
    (serverId: string) => {
      const client = runtime.getClient(serverId);
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return client;
    },
    [runtime, t],
  );

  const requestAttachmentToken = useCallback(
    async (task: MasterBacklogTask, attachment: TaskAttachment) => {
      const client = requireClient(task.serverId);
      const token = await client.requestTaskAttachmentDownloadToken({
        projectId: task.projectId,
        taskId: task.id,
        attachmentId: attachment.id,
      });
      if (token.error || !token.token) {
        throw new Error(token.error ?? "Failed to open attachment");
      }
      return token;
    },
    [requireClient],
  );

  const buildAttachmentUri = useCallback(
    (serverId: string, token: string) => {
      const target = resolveDaemonDownloadTarget(hostProfileByServerId.get(serverId));
      if (!target.baseUrl) {
        throw new Error("Host download URL is not available");
      }
      return buildDownloadUrl(target.baseUrl, token, isWeb ? target.authCredentials : null);
    },
    [hostProfileByServerId],
  );

  const handleAttachmentPress = useCallback(
    async (task: MasterBacklogTask, attachment: TaskAttachment) => {
      try {
        if (isRenderableAttachment(attachment)) {
          const token = await requestAttachmentToken(task, attachment);
          const downloadToken = token.token;
          if (!downloadToken) {
            throw new Error(token.error ?? "Failed to open attachment");
          }
          setPreview({
            taskId: task.id,
            serverId: task.serverId,
            projectId: task.projectId,
            attachment,
            uri: buildAttachmentUri(task.serverId, downloadToken),
            kind: attachment.mimeType.startsWith("video/") ? "video" : "image",
          });
          return;
        }

        await startDownload({
          serverId: task.serverId,
          scopeId: `task:${task.id}`,
          fileName: attachment.fileName,
          path: attachment.id,
          daemonProfile: hostProfileByServerId.get(task.serverId),
          requestFileDownloadToken: async () =>
            requestAttachmentToken(task, attachment).then((token) => ({
              token: token.token,
              fileName: token.fileName,
              mimeType: token.mimeType,
              error: token.error,
            })),
        });
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [buildAttachmentUri, hostProfileByServerId, requestAttachmentToken, startDownload, toast],
  );

  const handleCreateTask = useCallback(
    async (input: CreateTaskInput) => {
      if (!input.target) {
        throw new Error("Project is required");
      }
      const client = requireClient(input.target.serverId);
      const uploaded = await Promise.all(
        input.attachments.map(async (attachment) => {
          const result = await client.uploadFile({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            bytes: attachment.bytes,
          });
          if (result.error || !result.file) {
            throw new Error(result.error ?? `Failed to upload ${attachment.fileName}`);
          }
          return result.file;
        }),
      );
      const payload = await client.createTask({
        projectId: input.target.projectId,
        title: input.title,
        description: input.description,
        attachments: uploaded,
      });
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "Failed to add task");
      }
      await invalidateTasks();
    },
    [invalidateTasks, requireClient],
  );

  const updateTask = useCallback(
    async (
      task: MasterBacklogTask,
      input: { title?: string; description?: string; status?: TaskCard["status"] },
    ) => {
      const client = requireClient(task.serverId);
      const payload = await client.updateTask({
        projectId: task.projectId,
        taskId: task.id,
        ...input,
      });
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "Failed to update task");
      }
      await invalidateTasks();
    },
    [invalidateTasks, requireClient],
  );

  const handleUpdateTask = useCallback(
    async (
      taskId: string,
      input: { title?: string; description?: string; status?: TaskCard["status"] },
    ) => {
      if (!editingTask || editingTask.id !== taskId) {
        throw new Error("Task is unavailable");
      }
      await updateTask(editingTask, input);
    },
    [editingTask, updateTask],
  );

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      if (!editingTask || editingTask.id !== taskId) {
        throw new Error("Task is unavailable");
      }
      const client = requireClient(editingTask.serverId);
      const payload = await client.deleteTask({
        projectId: editingTask.projectId,
        taskId,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      await invalidateTasks();
    },
    [editingTask, invalidateTasks, requireClient],
  );

  const handleCreateWorkspaceFromTask = useCallback(
    async (task: MasterBacklogTask) => {
      setCreatingWorkspaceTaskKey(task.taskKey);
      try {
        const draftId = generateDraftId();
        const attachments = await buildWorkspaceDraftAttachmentsFromTask({
          task,
          requestAttachmentToken: (_taskId, attachment) =>
            requestAttachmentToken(task, attachment).then((token) => ({
              path: token.path,
              error: token.error,
            })),
        });
        useDraftStore.getState().saveDraftInput({
          draftKey: buildNewWorkspaceDraftKey({
            selectedServerId: task.serverId,
            selectedSourceDirectory: null,
            draftId,
          }),
          draft: {
            text: formatBacklogTaskWorkspacePrompt(task),
            attachments,
          },
        });
        router.navigate(
          buildNewWorkspaceRoute({
            serverId: task.serverId,
            projectId: task.projectId,
            displayName: task.projectName,
            draftId,
          }) as Href,
        );
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        setCreatingWorkspaceTaskKey(null);
      }
    },
    [requestAttachmentToken, toast],
  );

  const handleToggleTaskStatus = useCallback(
    async (task: MasterBacklogTask) => {
      try {
        await updateTask(task, {
          status: task.status === "completed" ? "active" : "completed",
        });
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [toast, updateTask],
  );

  const handleOpenCreate = useCallback(() => {
    setIsCreateOpen(true);
  }, []);
  const handleCloseCreate = useCallback(() => {
    setIsCreateOpen(false);
  }, []);
  const handleCloseEdit = useCallback(() => {
    setEditingTask(null);
  }, []);
  const handleClosePreview = useCallback(() => {
    setPreview(null);
  }, []);
  const handleDownloadPreview = useCallback(() => {
    if (!preview?.serverId || !preview.projectId) {
      return;
    }
    const task = visibleTasks.find(
      (entry) =>
        entry.id === preview.taskId &&
        entry.serverId === preview.serverId &&
        entry.projectId === preview.projectId,
    );
    if (!task) {
      return;
    }
    void handleAttachmentPress(task, {
      ...preview.attachment,
      mimeType: "application/octet-stream",
    });
  }, [handleAttachmentPress, preview, visibleTasks]);
  const handleCreateWorkspaceFromEditingTask = useCallback(() => {
    if (editingTask) {
      void handleCreateWorkspaceFromTask(editingTask);
    }
  }, [editingTask, handleCreateWorkspaceFromTask]);

  const headerLeft = useMemo(
    () => (
      <>
        <SidebarMenuToggle />
        <ScreenTitle>Backlog</ScreenTitle>
      </>
    ),
    [],
  );
  const headerRight = useMemo(
    () => (
      <Button
        size="sm"
        variant="default"
        leftIcon={Plus}
        onPress={handleOpenCreate}
        disabled={projectTargets.length === 0}
        testID="backlog-add-task"
      >
        Add
      </Button>
    ),
    [handleOpenCreate, projectTargets.length],
  );

  const showUnsupportedNotice = unsupportedHostCount > 0 && supportedHosts.length > 0;
  const hostErrors = tasksQuery.data?.hostErrors ?? [];
  const content = useMemo(() => {
    if (hosts.length === 0) {
      return <PanelMessage title="No hosts" message="Connect a host to use Backlog." />;
    }
    if (supportedHosts.length === 0) {
      return (
        <PanelMessage
          title="Update hosts to use this."
          message="Master Backlog needs a newer host."
        />
      );
    }
    if (tasksQuery.isLoading && tasksQuery.data === undefined) {
      return <PanelMessage title="Loading..." message={null} />;
    }
    if (tasksQuery.error) {
      return (
        <PanelMessage title="Could not load tasks" message={toErrorMessage(tasksQuery.error)} />
      );
    }
    if (visibleTasks.length === 0) {
      return (
        <PanelMessage
          title={searchQuery.trim() ? "No matching tasks" : "No tasks"}
          message={searchQuery.trim() ? "Try a different search." : null}
        />
      );
    }
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={scrollContentStyle}>
        {showUnsupportedNotice ? (
          <BacklogNotice message="Some hosts need an update before their backlog can appear here." />
        ) : null}
        {hostErrors.length > 0 ? (
          <BacklogNotice message="Some hosts could not load backlog tasks." />
        ) : null}
        <View onLayout={handleLayout} style={viewMode === "grid" ? styles.grid : styles.list}>
          {visibleTasks.map((task) => (
            <TaskCardView
              key={task.taskKey}
              task={task}
              mode={viewMode}
              cardStyle={taskCardStyle}
              contextLabel={`${task.projectName} - ${task.serverName}`}
              onOpenTask={setEditingTask}
              onAttachmentPress={handleAttachmentPress}
              onCreateWorkspace={handleCreateWorkspaceFromTask}
              isCreatingWorkspace={creatingWorkspaceTaskKey === task.taskKey}
              onToggleStatus={handleToggleTaskStatus}
            />
          ))}
        </View>
      </ScrollView>
    );
  }, [
    creatingWorkspaceTaskKey,
    handleAttachmentPress,
    handleCreateWorkspaceFromTask,
    handleLayout,
    handleToggleTaskStatus,
    hostErrors.length,
    hosts.length,
    searchQuery,
    showUnsupportedNotice,
    supportedHosts.length,
    taskCardStyle,
    tasksQuery.data,
    tasksQuery.error,
    tasksQuery.isLoading,
    viewMode,
    visibleTasks,
  ]);
  const previewDownloadHandler = preview ? handleDownloadPreview : undefined;

  return (
    <View style={styles.screen}>
      <ScreenHeader left={headerLeft} borderless right={headerRight} />
      <View style={styles.contentShell}>
        <TitlebarDragRegion />
        <View style={styles.content}>
          <View style={styles.titleRow}>
            <View style={styles.titleGroup}>
              <Text style={styles.title}>Backlog</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                All hosts
              </Text>
            </View>
            <SegmentedControl
              size="sm"
              value={viewMode}
              onValueChange={setViewMode}
              options={VIEW_MODE_OPTIONS}
            />
          </View>
          <BacklogSearchField value={searchQuery} onChangeText={setSearchQuery} />

          {content}
        </View>
      </View>

      <TaskFormSheet
        visible={isCreateOpen}
        projectTargets={projectTargets}
        onClose={handleCloseCreate}
        onCreate={handleCreateTask}
      />
      <TaskFormSheet
        visible={editingTask !== null}
        projectName={
          editingTask ? `${editingTask.projectName} - ${editingTask.serverName}` : undefined
        }
        task={editingTask}
        onClose={handleCloseEdit}
        onUpdate={handleUpdateTask}
        onDelete={handleDeleteTask}
        onCreateWorkspace={handleCreateWorkspaceFromEditingTask}
        isCreatingWorkspace={editingTask ? creatingWorkspaceTaskKey === editingTask.taskKey : false}
      />
      <TaskAttachmentPreviewSheet
        preview={preview}
        onClose={handleClosePreview}
        onDownload={previewDownloadHandler}
      />
    </View>
  );
}

function BacklogSearchField({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.searchField}>
      <Search size={16} color={styles.searchIcon.color} />
      <AdaptiveTextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Search tasks..."
        style={styles.searchInput}
        autoCapitalize="none"
        autoCorrect={false}
        testID="backlog-search"
      />
    </View>
  );
}

function PanelMessage({ title, message }: { title: string; message: string | null }) {
  return (
    <View style={styles.panelMessage}>
      <Text style={styles.panelMessageTitle}>{title}</Text>
      {message ? <Text style={styles.panelMessageText}>{message}</Text> : null}
    </View>
  );
}

function BacklogNotice({ message }: { message: string }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{message}</Text>
    </View>
  );
}

function TaskCardView<TTask extends TaskCard>({
  task,
  mode,
  cardStyle,
  contextLabel,
  onOpenTask,
  onAttachmentPress,
  onCreateWorkspace,
  isCreatingWorkspace,
  onToggleStatus,
}: {
  task: TTask;
  mode: BacklogViewMode;
  cardStyle: StyleProp<ViewStyle>;
  contextLabel?: string | null;
  onOpenTask: (task: TTask) => void;
  onAttachmentPress: (task: TTask, attachment: TaskAttachment) => void;
  onCreateWorkspace: (task: TTask) => void;
  isCreatingWorkspace: boolean;
  onToggleStatus: (task: TTask) => void;
}) {
  const isCompleted = task.status === "completed";
  const titleLineLimit = getTaskTitleLineLimit({
    mode,
    hasAttachments: task.attachments.length > 0,
  });
  const [titleLineCount, setTitleLineCount] = useState(1);
  const taskTitleStyle = useMemo(
    () => [styles.taskTitle, isCompleted ? styles.taskTitleCompleted : null],
    [isCompleted],
  );
  const descriptionLineLimit = getTaskDescriptionLineLimit({
    mode,
    titleLineCount,
    titleLineLimit,
  });
  const shouldShowDescription = Boolean(task.description && descriptionLineLimit > 0);
  const handleAttachmentPressForTask = useCallback(
    (_task: TaskCard, attachment: TaskAttachment) => {
      onAttachmentPress(task, attachment);
    },
    [onAttachmentPress, task],
  );
  const attachmentSummary = renderAttachmentSummary(task, mode, handleAttachmentPressForTask);
  const cardPressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.taskCard,
      mode === "list" ? styles.taskCardList : null,
      isCompleted ? styles.taskCardCompleted : null,
      Boolean(hovered) || pressed ? styles.taskCardHovered : null,
      cardStyle,
    ],
    [cardStyle, isCompleted, mode],
  );
  const handleStatusPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onToggleStatus(task);
    },
    [onToggleStatus, task],
  );
  const handleCreateWorkspacePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onCreateWorkspace(task);
    },
    [onCreateWorkspace, task],
  );
  const handlePress = useCallback(() => {
    onOpenTask(task);
  }, [onOpenTask, task]);
  const handleTitleTextLayout = useCallback((event: NativeSyntheticEvent<TextLayoutEventData>) => {
    setTitleLineCount(event.nativeEvent.lines.length);
  }, []);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task.title}
      onPress={handlePress}
      style={cardPressableStyle}
      testID={`task-card-${task.id}`}
    >
      <View style={styles.taskCardHeader}>
        <Text
          style={taskTitleStyle}
          numberOfLines={titleLineLimit}
          onTextLayout={handleTitleTextLayout}
        >
          {task.title}
        </Text>
        <View style={styles.taskCardActions}>
          <Button
            size="xs"
            variant="ghost"
            leftIcon={FolderPlus}
            onPress={handleCreateWorkspacePress}
            loading={isCreatingWorkspace}
            accessibilityLabel="Create workspace from task"
          />
          <Button
            size="xs"
            variant="ghost"
            leftIcon={isCompleted ? RotateCcw : Check}
            onPress={handleStatusPress}
            accessibilityLabel={isCompleted ? "Reopen task" : "Complete task"}
          />
        </View>
      </View>
      {shouldShowDescription ? (
        <Text style={styles.taskDescription} numberOfLines={descriptionLineLimit}>
          {task.description}
        </Text>
      ) : null}
      {contextLabel ? (
        <Text style={styles.taskContext} numberOfLines={1}>
          {contextLabel}
        </Text>
      ) : null}
      {attachmentSummary}
    </Pressable>
  );
}

function getTaskTitleLineLimit(input: { mode: BacklogViewMode; hasAttachments: boolean }): number {
  if (input.mode === "list") {
    return 4;
  }
  return input.hasAttachments ? 5 : 7;
}

function getTaskDescriptionLineLimit(input: {
  mode: BacklogViewMode;
  titleLineCount: number;
  titleLineLimit: number;
}): number {
  if (input.titleLineCount >= input.titleLineLimit) {
    return 0;
  }
  return input.mode === "grid" ? 5 : 3;
}

function renderAttachmentSummary(
  task: TaskCard,
  mode: BacklogViewMode,
  onAttachmentPress: (task: TaskCard, attachment: TaskAttachment) => void,
) {
  if (task.attachments.length === 0) {
    return null;
  }
  if (mode === "grid") {
    return <AttachmentGrid task={task} onAttachmentPress={onAttachmentPress} />;
  }
  return <AttachmentFileList task={task} onAttachmentPress={onAttachmentPress} />;
}

function AttachmentGrid({
  task,
  onAttachmentPress,
}: {
  task: TaskCard;
  onAttachmentPress: (task: TaskCard, attachment: TaskAttachment) => void;
}) {
  return (
    <View style={styles.attachmentGrid}>
      {task.attachments.slice(0, 4).map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          task={task}
          attachment={attachment}
          onAttachmentPress={onAttachmentPress}
        />
      ))}
      {task.attachments.length > 4 ? (
        <View style={styles.attachmentTile}>
          <Text style={styles.attachmentOverflow}>+{task.attachments.length - 4}</Text>
        </View>
      ) : null}
    </View>
  );
}

function AttachmentFileList({
  task,
  onAttachmentPress,
}: {
  task: TaskCard;
  onAttachmentPress: (task: TaskCard, attachment: TaskAttachment) => void;
}) {
  return (
    <View style={styles.attachmentList}>
      {task.attachments.slice(0, 3).map((attachment) => (
        <AttachmentFileChip
          key={attachment.id}
          task={task}
          attachment={attachment}
          onAttachmentPress={onAttachmentPress}
        />
      ))}
      {task.attachments.length > 3 ? (
        <Text style={styles.fileChipMore}>+{task.attachments.length - 3}</Text>
      ) : null}
    </View>
  );
}

function AttachmentTile({
  task,
  attachment,
  onAttachmentPress,
}: {
  task: TaskCard;
  attachment: TaskAttachment;
  onAttachmentPress: (task: TaskCard, attachment: TaskAttachment) => void;
}) {
  const Icon = getAttachmentIcon(attachment.mimeType);
  const handlePress = useCallback(() => {
    onAttachmentPress(task, attachment);
  }, [attachment, onAttachmentPress, task]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={attachment.fileName}
      onPress={handlePress}
      style={styles.attachmentTile}
    >
      <Icon size={15} color="#9ca3af" />
      <Text style={styles.attachmentTileText} numberOfLines={1}>
        {attachment.fileName}
      </Text>
    </Pressable>
  );
}

function AttachmentFileChip({
  task,
  attachment,
  onAttachmentPress,
}: {
  task: TaskCard;
  attachment: TaskAttachment;
  onAttachmentPress: (task: TaskCard, attachment: TaskAttachment) => void;
}) {
  const handlePress = useCallback(() => {
    onAttachmentPress(task, attachment);
  }, [attachment, onAttachmentPress, task]);

  return (
    <Pressable onPress={handlePress} style={styles.fileChip}>
      <Text style={styles.fileChipText} numberOfLines={1}>
        {attachment.fileName}
      </Text>
    </Pressable>
  );
}

function getAttachmentIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) {
    return ImageIcon;
  }
  if (mimeType.startsWith("video/")) {
    return Video;
  }
  return FileText;
}

function TaskFormSheet({
  visible,
  projectName,
  projectTargets,
  task,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onCreateWorkspace,
  isCreatingWorkspace,
}: {
  visible: boolean;
  projectName?: string;
  projectTargets?: readonly MasterBacklogProjectTarget[];
  task?: TaskCard | null;
  onClose: () => void;
  onCreate?: (input: CreateTaskInput) => Promise<void>;
  onUpdate?: (
    taskId: string,
    input: { title?: string; description?: string; status?: TaskCard["status"] },
  ) => Promise<void>;
  onDelete?: (taskId: string) => Promise<void>;
  onCreateWorkspace?: (task: TaskCard) => void;
  isCreatingWorkspace?: boolean;
}) {
  const { pickFiles } = useFilePicker();
  const isEdit = Boolean(task);
  const nextAttachmentKey = useRef(0);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const projectPickerAnchorRef = useRef<View | null>(null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [attachments, setAttachments] = useState<PendingPickedFile[]>([]);
  const [selectedTargetOptionId, setSelectedTargetOptionId] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setAttachments([]);
    setSelectedTargetOptionId(projectTargets?.[0]?.optionId ?? "");
    setError(null);
    setResetKey((current) => current + 1);
  }, [projectTargets, task?.description, task?.id, task?.title, visible]);

  useEffect(() => {
    if (!visible || isEdit || !projectTargets) {
      return;
    }
    setSelectedTargetOptionId((current) => {
      if (projectTargets.some((target) => target.optionId === current)) {
        return current;
      }
      return projectTargets[0]?.optionId ?? "";
    });
  }, [isEdit, projectTargets, visible]);

  const targetByOptionId = useMemo(
    () => new Map((projectTargets ?? []).map((target) => [target.optionId, target] as const)),
    [projectTargets],
  );
  const selectedProjectTarget = targetByOptionId.get(selectedTargetOptionId) ?? null;

  const header = useMemo<SheetHeader>(
    () => ({
      title: isEdit ? "Edit task" : "Add task",
      subtitle: projectName ? <Text style={styles.sheetSubtitle}>{projectName}</Text> : undefined,
    }),
    [isEdit, projectName],
  );

  const insertMarkdown = useCallback((snippet: string) => {
    setDescription((current) => {
      const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      return `${current}${separator}${snippet}`;
    });
    setResetKey((current) => current + 1);
  }, []);

  const handlePickFiles = useCallback(async () => {
    const picked = await pickFiles();
    if (!picked || picked.length === 0) {
      return;
    }
    setAttachments((current) => [
      ...current,
      ...picked.map((attachment) => {
        const key = `${attachment.fileName}-${attachment.bytes.byteLength}-${nextAttachmentKey.current}`;
        nextAttachmentKey.current += 1;
        return {
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
          key,
        };
      }),
    ]);
  }, [pickFiles]);

  const handleSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required");
      return;
    }
    if (!isEdit && projectTargets && !selectedProjectTarget) {
      setError("Project is required");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      if (task && onUpdate) {
        await onUpdate(task.id, { title: trimmedTitle, description });
      } else if (onCreate) {
        await onCreate({
          title: trimmedTitle,
          description,
          attachments: attachments.map((attachment) => ({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            bytes: attachment.bytes,
          })),
          ...(selectedProjectTarget ? { target: selectedProjectTarget } : {}),
        });
      }
      onClose();
    } catch (submitError) {
      setError(toErrorMessage(submitError));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    attachments,
    description,
    isEdit,
    onClose,
    onCreate,
    onUpdate,
    projectTargets,
    selectedProjectTarget,
    task,
    title,
  ]);

  const handleDelete = useCallback(async () => {
    if (!task || !onDelete) {
      return;
    }
    setIsDeleting(true);
    setError(null);
    try {
      await onDelete(task.id);
      onClose();
    } catch (deleteError) {
      setError(toErrorMessage(deleteError));
    } finally {
      setIsDeleting(false);
    }
  }, [onClose, onDelete, task]);
  const handleCreateWorkspace = useCallback(() => {
    if (task && onCreateWorkspace) {
      onCreateWorkspace({
        ...task,
        title: title.trim() || task.title,
        description,
      });
    }
  }, [description, onCreateWorkspace, task, title]);

  const insertBold = useCallback(() => {
    insertMarkdown("**bold**");
  }, [insertMarkdown]);
  const insertItalic = useCallback(() => {
    insertMarkdown("_italic_");
  }, [insertMarkdown]);
  const insertUnorderedList = useCallback(() => {
    insertMarkdown("- ");
  }, [insertMarkdown]);
  const insertOrderedList = useCallback(() => {
    insertMarkdown("1. ");
  }, [insertMarkdown]);

  const footer = useMemo(
    () => (
      <View style={styles.sheetFooter}>
        {isEdit ? (
          <View style={styles.sheetFooterLeft}>
            <Button
              size="sm"
              variant="outline"
              leftIcon={FolderPlus}
              onPress={handleCreateWorkspace}
              loading={isCreatingWorkspace}
              disabled={isSubmitting || isDeleting}
            >
              Create workspace
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={Trash2}
              onPress={handleDelete}
              loading={isDeleting}
              disabled={isSubmitting || Boolean(isCreatingWorkspace)}
            >
              Delete
            </Button>
          </View>
        ) : (
          <View />
        )}
        <View style={styles.sheetFooterRight}>
          <Button size="sm" variant="ghost" onPress={onClose} disabled={isSubmitting || isDeleting}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="default"
            onPress={handleSubmit}
            loading={isSubmitting}
            disabled={isDeleting || Boolean(isCreatingWorkspace)}
          >
            {isEdit ? "Save" : "Add"}
          </Button>
        </View>
      </View>
    ),
    [
      handleCreateWorkspace,
      handleDelete,
      handleSubmit,
      isCreatingWorkspace,
      isDeleting,
      isEdit,
      isSubmitting,
      onClose,
    ],
  );

  if (!visible) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={620}
      testID="task-form-sheet"
    >
      {!isEdit && projectTargets ? (
        <View style={styles.field}>
          <Text style={styles.label}>Project</Text>
          <TaskProjectTargetPicker
            targets={projectTargets}
            targetByOptionId={targetByOptionId}
            value={selectedTargetOptionId}
            selectedTarget={selectedProjectTarget}
            open={projectPickerOpen}
            onOpenChange={setProjectPickerOpen}
            anchorRef={projectPickerAnchorRef}
            onSelect={setSelectedTargetOptionId}
          />
        </View>
      ) : null}
      <View style={styles.field}>
        <Text style={styles.label}>Title</Text>
        <AdaptiveTextInput
          initialValue={title}
          resetKey={`task-title-${task?.id ?? "new"}-${resetKey}`}
          value={title}
          onChangeText={setTitle}
          placeholder="Task title"
          style={styles.input}
          autoFocus
        />
      </View>
      <View style={styles.field}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>Description</Text>
          <View style={styles.formatToolbar}>
            <Button size="xs" variant="ghost" leftIcon={Bold} onPress={insertBold} />
            <Button size="xs" variant="ghost" leftIcon={Italic} onPress={insertItalic} />
            <Button size="xs" variant="ghost" leftIcon={List} onPress={insertUnorderedList} />
            <Button size="xs" variant="ghost" leftIcon={ListOrdered} onPress={insertOrderedList} />
          </View>
        </View>
        <AdaptiveTextInput
          initialValue={description}
          resetKey={`task-description-${task?.id ?? "new"}-${resetKey}`}
          value={description}
          onChangeText={setDescription}
          placeholder="Add details"
          style={styles.descriptionInput}
          multiline
          numberOfLines={8}
          textAlignVertical="top"
        />
      </View>
      {!isEdit ? (
        <View style={styles.field}>
          <Button size="sm" variant="outline" leftIcon={Paperclip} onPress={handlePickFiles}>
            Attach
          </Button>
          {attachments.length > 0 ? (
            <View style={styles.pendingAttachmentList}>
              {attachments.map((attachment) => (
                <View key={attachment.key} style={styles.pendingAttachment}>
                  <Text style={styles.pendingAttachmentName} numberOfLines={1}>
                    {attachment.fileName}
                  </Text>
                  <Text style={styles.pendingAttachmentMeta}>
                    {formatBytes(attachment.bytes.byteLength)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </AdaptiveModalSheet>
  );
}

function TaskProjectTargetPicker({
  targets,
  targetByOptionId,
  value,
  selectedTarget,
  open,
  onOpenChange,
  anchorRef,
  onSelect,
}: {
  targets: readonly MasterBacklogProjectTarget[];
  targetByOptionId: ReadonlyMap<string, MasterBacklogProjectTarget>;
  value: string;
  selectedTarget: MasterBacklogProjectTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<View | null>;
  onSelect: (id: string) => void;
}) {
  const options = useMemo<ComboboxOption[]>(
    () =>
      targets.map((target) => ({
        id: target.optionId,
        label: target.projectName,
        description: `${target.serverName} - ${shortenPath(target.repoRoot)}`,
      })),
    [targets],
  );
  const displayValue = selectedTarget?.projectName ?? "Select project";
  const description = selectedTarget
    ? `${selectedTarget.serverName} - ${shortenPath(selectedTarget.repoRoot)}`
    : null;
  const isPlaceholder = !selectedTarget;
  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.selectTrigger,
      (Boolean(hovered) || pressed || open) && styles.selectTriggerActive,
    ],
    [open],
  );
  const optionLeadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Folder size={16} color={styles.chevron.color} />
      </View>
    ),
    [],
  );
  const handlePress = useCallback(() => {
    onOpenChange(!open);
  }, [onOpenChange, open]);
  const handleSelect = useCallback(
    (id: string) => {
      if (!targetByOptionId.has(id)) {
        return;
      }
      onSelect(id);
      onOpenChange(false);
    },
    [onOpenChange, onSelect, targetByOptionId],
  );
  const renderOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <ComboboxItem
        label={option.label}
        description={option.description}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={optionLeadingSlot}
      />
    ),
    [optionLeadingSlot],
  );

  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handlePress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`Select project (${displayValue})`}
          testID="backlog-project-trigger"
        >
          <Text
            style={isPlaceholder ? styles.selectTriggerPlaceholder : styles.selectTriggerText}
            numberOfLines={1}
          >
            {displayValue}
          </Text>
          <ChevronDown size={16} color={styles.chevron.color} />
        </Pressable>
      </View>
      {description ? <Text style={styles.hint}>{description}</Text> : null}
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        searchable
        searchPlaceholder="Search projects..."
        emptyText="No projects found"
        title="Select project"
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        renderOption={renderOption}
      />
    </>
  );
}

function TaskAttachmentPreviewSheet({
  preview,
  onClose,
  onDownload,
}: {
  preview: AttachmentPreview | null;
  onClose: () => void;
  onDownload?: () => void;
}) {
  const header = useMemo<SheetHeader>(
    () => ({
      title: preview?.attachment.fileName ?? "Attachment",
      actions: onDownload ? (
        <Button size="xs" variant="ghost" leftIcon={Download} onPress={onDownload}>
          Download
        </Button>
      ) : undefined,
    }),
    [onDownload, preview?.attachment.fileName],
  );
  const imageSource = useMemo(() => ({ uri: preview?.uri ?? "" }), [preview?.uri]);

  if (!preview) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={760}
      scrollable={false}
      testID="task-attachment-preview"
    >
      {preview.kind === "image" ? (
        <Image source={imageSource} resizeMode="contain" style={styles.previewMedia} />
      ) : (
        <TaskVideoPreview uri={preview.uri} style={styles.previewMedia} />
      )}
    </AdaptiveModalSheet>
  );
}

function isRenderableAttachment(attachment: TaskAttachment): boolean {
  return attachment.mimeType.startsWith("image/") || attachment.mimeType.startsWith("video/");
}

async function buildWorkspaceDraftAttachmentsFromTask(input: {
  task: TaskCard;
  requestAttachmentToken: (
    taskId: string,
    attachment: TaskAttachment,
  ) => Promise<{ path: string | null; error: string | null }>;
}): Promise<UserComposerAttachment[]> {
  const attachments: UserComposerAttachment[] = [];
  for (const attachment of input.task.attachments) {
    const reference = await input.requestAttachmentToken(input.task.id, attachment);
    if (!reference.path) {
      throw new Error(reference.error ?? `Failed to attach ${attachment.fileName}`);
    }
    attachments.push({
      kind: "file",
      attachment: {
        type: "uploaded_file",
        id: `task_${input.task.id}_${attachment.id}`,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        path: reference.path,
      },
    });
  }
  return attachments;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentShell: {
    position: "relative",
    flex: 1,
    alignItems: "center",
  },
  content: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    flex: 1,
    minHeight: 0,
  },
  titleRow: {
    paddingHorizontal: CONTENT_PADDING,
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  titleGroup: {
    minWidth: 0,
    flex: 1,
    gap: theme.spacing[1],
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  searchField: {
    marginHorizontal: CONTENT_PADDING,
    marginBottom: theme.spacing[3],
    minHeight: 40,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  searchIcon: {
    color: theme.colors.foregroundMuted,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 38,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  scroll: {
    flex: 1,
  },
  grid: {
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: CARD_GAP,
  },
  list: {
    width: "100%",
    gap: CARD_GAP,
  },
  taskCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    overflow: "hidden",
  },
  taskCardList: {
    width: "100%",
  },
  taskCardCompleted: {
    opacity: 0.72,
  },
  taskCardHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  taskCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  taskCardActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
  },
  taskTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 20,
  },
  taskTitleCompleted: {
    textDecorationLine: "line-through",
    color: theme.colors.foregroundMuted,
  },
  taskDescription: {
    flexShrink: 1,
    minHeight: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  taskContext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  attachmentGrid: {
    marginTop: "auto",
    height: 54,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  attachmentTile: {
    flex: 1,
    minWidth: 72,
    maxWidth: 120,
    minHeight: 24,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  attachmentTileText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  attachmentOverflow: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  attachmentList: {
    marginTop: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 26,
  },
  fileChip: {
    maxWidth: 160,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  fileChipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  fileChipMore: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  panelMessage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: CONTENT_PADDING,
  },
  panelMessageTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  panelMessageText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  notice: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  noticeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sheetSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  field: {
    gap: theme.spacing[2],
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  formatToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  input: {
    minHeight: 40,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  selectTrigger: {
    minHeight: 40,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  selectTriggerActive: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  selectTriggerText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  selectTriggerPlaceholder: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  optionIconBox: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  chevron: {
    color: theme.colors.foregroundMuted,
  },
  descriptionInput: {
    minHeight: 180,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  pendingAttachmentList: {
    gap: theme.spacing[1],
  },
  pendingAttachment: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  pendingAttachmentName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  pendingAttachmentMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  sheetFooter: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sheetFooterLeft: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  sheetFooterRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  previewMedia: {
    width: "100%",
    height: 420,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
}));
