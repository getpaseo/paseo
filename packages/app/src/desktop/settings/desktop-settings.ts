import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import {
  useDesktopIpcErrorReporter,
  useDesktopIpcQueryErrorToast,
} from "@/desktop/hooks/desktop-ipc-error";
import type { ReleaseChannel } from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";

const DESKTOP_SETTINGS_QUERY_KEY = ["desktop-settings"] as const;

export interface DesktopSettings {
  releaseChannel: ReleaseChannel;
  notifications: {
    playSound: boolean;
  };
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
  projects: {
    /** Where Browse in Add Project opens. Wins over `lastBrowseDirectory` when set. */
    defaultBrowseDirectory: string | null;
    /** The parent of the directory last picked with Browse. */
    lastBrowseDirectory: string | null;
  };
}

export interface DesktopSettingsPatch {
  releaseChannel?: ReleaseChannel;
  notifications?: Partial<DesktopSettings["notifications"]>;
  daemon?: Partial<DesktopSettings["daemon"]>;
  projects?: Partial<DesktopSettings["projects"]>;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  releaseChannel: "stable",
  notifications: {
    playSound: true,
  },
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
  projects: {
    defaultBrowseDirectory: null,
    lastBrowseDirectory: null,
  },
};

export function useDesktopSettings(): {
  settings: DesktopSettings;
  isLoading: boolean;
  isSaving: boolean;
  error: unknown;
  updateSettings: (updates: DesktopSettingsPatch) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const {
    data,
    isPending,
    error: loadError,
  } = useQuery<DesktopSettings, Error>({
    queryKey: DESKTOP_SETTINGS_QUERY_KEY,
    queryFn: loadDesktopSettings,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  useDesktopIpcQueryErrorToast({
    error: loadError,
    message: i18n.t("desktop.settings.loadFailed"),
    logLabel: "[DesktopSettings] Failed to load settings",
  });

  const { mutateAsync: saveDesktopSettings, isPending: isSaving } = useMutation<
    DesktopSettings,
    Error,
    DesktopSettingsPatch,
    DesktopSettingsMutationContext
  >({
    mutationFn: updatePersistedDesktopSettings,
    onMutate: (updates) => {
      const previous =
        queryClient.getQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY) ??
        DEFAULT_DESKTOP_SETTINGS;
      queryClient.setQueryData<DesktopSettings>(
        DESKTOP_SETTINGS_QUERY_KEY,
        mergeDesktopSettings(previous, updates),
      );
      return { previous };
    },
    onSuccess: (persisted) => {
      queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, persisted);
    },
    onError: (saveError, _updates, context) => {
      if (context) {
        queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, context.previous);
      }
      reportError({
        error: saveError,
        message: i18n.t("desktop.settings.saveFailed"),
        logLabel: "[DesktopSettings] Failed to save settings",
      });
    },
  });

  const updateSettings = useCallback(
    async (updates: DesktopSettingsPatch) => {
      if (!getIsElectron()) {
        return;
      }

      await saveDesktopSettings(updates);
    },
    [saveDesktopSettings],
  );

  return {
    settings: data ?? DEFAULT_DESKTOP_SETTINGS,
    isLoading: isPending,
    isSaving,
    error: loadError ?? null,
    updateSettings,
  };
}

interface DesktopSettingsMutationContext {
  previous: DesktopSettings;
}

export async function loadDesktopSettings(): Promise<DesktopSettings> {
  if (!getIsElectron()) {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  return parseDesktopSettings(await invokeDesktopCommand<unknown>("get_desktop_settings"));
}

export async function updatePersistedDesktopSettings(
  updates: DesktopSettingsPatch,
): Promise<DesktopSettings> {
  if (!getIsElectron()) {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  return parseDesktopSettings(
    await invokeDesktopCommand<unknown>("patch_desktop_settings", normalizePatch(updates)),
  );
}

export async function migrateLegacyDesktopSettings(input: {
  manageBuiltInDaemon?: boolean;
  releaseChannel?: ReleaseChannel;
}): Promise<void> {
  if (!getIsElectron()) {
    return;
  }
  await invokeDesktopCommand("migrate_legacy_desktop_settings", input);
}

function parseDesktopSettings(raw: unknown): DesktopSettings {
  const record = isRecord(raw) ? raw : {};
  const notifications = isRecord(record.notifications) ? record.notifications : {};
  const daemon = isRecord(record.daemon) ? record.daemon : {};
  const projects = isRecord(record.projects) ? record.projects : {};

  return {
    releaseChannel: record.releaseChannel === "beta" ? "beta" : "stable",
    notifications: {
      playSound:
        typeof notifications.playSound === "boolean"
          ? notifications.playSound
          : DEFAULT_DESKTOP_SETTINGS.notifications.playSound,
    },
    daemon: {
      manageBuiltInDaemon:
        typeof daemon.manageBuiltInDaemon === "boolean"
          ? daemon.manageBuiltInDaemon
          : DEFAULT_DESKTOP_SETTINGS.daemon.manageBuiltInDaemon,
      keepRunningAfterQuit:
        typeof daemon.keepRunningAfterQuit === "boolean"
          ? daemon.keepRunningAfterQuit
          : DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit,
    },
    projects: {
      defaultBrowseDirectory: parseDirectoryPath(projects.defaultBrowseDirectory),
      lastBrowseDirectory: parseDirectoryPath(projects.lastBrowseDirectory),
    },
  };
}

function parseDirectoryPath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mergeDesktopSettings(
  current: DesktopSettings,
  updates: DesktopSettingsPatch,
): DesktopSettings {
  return {
    releaseChannel: updates.releaseChannel ?? current.releaseChannel,
    notifications: {
      ...current.notifications,
      ...updates.notifications,
    },
    daemon: {
      ...current.daemon,
      ...updates.daemon,
    },
    projects: {
      ...current.projects,
      ...updates.projects,
    },
  };
}

function normalizePatch(updates: DesktopSettingsPatch): Record<string, unknown> {
  return {
    ...(updates.releaseChannel ? { releaseChannel: updates.releaseChannel } : {}),
    ...(updates.notifications ? { notifications: updates.notifications } : {}),
    ...(updates.daemon ? { daemon: updates.daemon } : {}),
    ...(updates.projects ? { projects: updates.projects } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
