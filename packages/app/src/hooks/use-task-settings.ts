// useTaskSettings — adapted from emdash's useTaskSettings.ts
// Persists task-related settings using AsyncStorage

import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TaskSettings } from "@/components/kanban/task-settings-card";

const STORAGE_KEY = "hubcode:taskSettings";

const DEFAULT_SETTINGS: TaskSettings = {
  autoGenerateNames: true,
  autoApproveByDefault: false,
  createWorktreeByDefault: true,
  autoTrustWorktrees: false,
};

export function useTaskSettings() {
  const [settings, setSettings] = useState<TaskSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<TaskSettings>;
          setSettings({ ...DEFAULT_SETTINGS, ...parsed });
        } catch {
          // ignore
        }
      }
      setIsLoading(false);
    });
  }, []);

  const updateSettings = useCallback((changes: Partial<TaskSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...changes };
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { settings, updateSettings, isLoading };
}
