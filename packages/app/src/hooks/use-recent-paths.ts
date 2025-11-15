import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@paseo:recent-paths';
const MAX_RECENT_PATHS = 3;

export interface UseRecentPathsReturn {
  recentPaths: string[];
  isLoading: boolean;
  addRecentPath: (path: string) => Promise<void>;
  clearRecentPaths: () => Promise<void>;
}

export function useRecentPaths(): UseRecentPathsReturn {
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load recent paths from AsyncStorage on mount
  useEffect(() => {
    loadRecentPaths();
  }, []);

  async function loadRecentPaths() {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        setRecentPaths(parsed);
      }
    } catch (error) {
      console.error('[RecentPaths] Failed to load recent paths:', error);
      // Continue with empty array
    } finally {
      setIsLoading(false);
    }
  }

  const addRecentPath = useCallback(async (path: string) => {
    try {
      // Remove duplicates and add to front
      const filtered = recentPaths.filter((p) => p !== path);
      const updated = [path, ...filtered].slice(0, MAX_RECENT_PATHS);

      setRecentPaths(updated);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      console.error('[RecentPaths] Failed to save recent path:', error);
      throw error;
    }
  }, [recentPaths]);

  const clearRecentPaths = useCallback(async () => {
    try {
      setRecentPaths([]);
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error('[RecentPaths] Failed to clear recent paths:', error);
      throw error;
    }
  }, []);

  return {
    recentPaths,
    isLoading,
    addRecentPath,
    clearRecentPaths,
  };
}
