import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { ReleaseChannel } from "@/hooks/use-settings";

export const DESKTOP_SETTINGS_QUERY_KEY = ["desktop-settings"] as const;

export interface DesktopSettings {
  releaseChannel: ReleaseChannel;
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
}

export interface DesktopSettingsPatch {
  releaseChannel?: ReleaseChannel;
  daemon?: Partial<DesktopSettings["daemon"]>;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  releaseChannel: "stable",
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: true,
  },
};

export function useDesktopSettings(): {
  settings: DesktopSettings;
  isLoading: boolean;
  error: unknown;
  updateSettings: (updates: DesktopSettingsPatch) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: DESKTOP_SETTINGS_QUERY_KEY,
    queryFn: loadDesktopSettings,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updateSettings = useCallback(
    async (updates: DesktopSettingsPatch) => {
      if (!getIsElectron()) {
        return;
      }

      const previous =
        queryClient.getQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY) ??
        DEFAULT_DESKTOP_SETTINGS;
      const next = mergeDesktopSettings(previous, updates);
      queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, next);
      const persisted = await updatePersistedDesktopSettings(updates);
      queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, persisted);
    },
    [queryClient],
  );

  return {
    settings: data ?? DEFAULT_DESKTOP_SETTINGS,
    isLoading: isPending,
    error: error ?? null,
    updateSettings,
  };
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
  const daemon = isRecord(record.daemon) ? record.daemon : {};

  return {
    releaseChannel: record.releaseChannel === "beta" ? "beta" : "stable",
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
  };
}

function mergeDesktopSettings(
  current: DesktopSettings,
  updates: DesktopSettingsPatch,
): DesktopSettings {
  return {
    releaseChannel: updates.releaseChannel ?? current.releaseChannel,
    daemon: {
      ...current.daemon,
      ...updates.daemon,
    },
  };
}

function normalizePatch(updates: DesktopSettingsPatch): Record<string, unknown> {
  return {
    ...(updates.releaseChannel ? { releaseChannel: updates.releaseChannel } : {}),
    ...(updates.daemon ? { daemon: updates.daemon } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
