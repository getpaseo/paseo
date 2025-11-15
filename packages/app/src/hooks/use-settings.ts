import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@paseo:settings';

export interface Settings {
  serverUrl: string;
  useSpeaker: boolean;
  keepScreenOn: boolean;
  theme: 'dark' | 'light' | 'auto';
}

const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'wss://mohameds-macbook-pro.tail8fe838.ts.net/ws',
  useSpeaker: true,
  keepScreenOn: true,
  theme: 'dark',
};

export interface UseSettingsReturn {
  settings: Settings;
  isLoading: boolean;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;
  resetSettings: () => Promise<void>;
}

export function useSettings(): UseSettingsReturn {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  // Load settings from AsyncStorage on mount
  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<Settings>;
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      }
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error);
      // Continue with default settings
    } finally {
      setIsLoading(false);
    }
  }

  const updateSettings = useCallback(async (updates: Partial<Settings>) => {
    try {
      const newSettings = { ...settings, ...updates };
      setSettings(newSettings);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
    } catch (error) {
      console.error('[Settings] Failed to save settings:', error);
      throw error;
    }
  }, [settings]);

  const resetSettings = useCallback(async () => {
    try {
      setSettings(DEFAULT_SETTINGS);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
    } catch (error) {
      console.error('[Settings] Failed to reset settings:', error);
      throw error;
    }
  }, []);

  return {
    settings,
    isLoading,
    updateSettings,
    resetSettings,
  };
}
