import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FormPreferences } from "./preferences";

export const CREATE_AGENT_PREFERENCES_STORAGE_KEY = "@paseo:create-agent-preferences";

export interface CreateAgentPreferenceStorage {
  read(): Promise<unknown>;
  write(preferences: FormPreferences): Promise<void>;
}

export class AsyncStorageCreateAgentPreferenceStorage implements CreateAgentPreferenceStorage {
  async read(): Promise<unknown> {
    const stored = await AsyncStorage.getItem(CREATE_AGENT_PREFERENCES_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  }

  async write(preferences: FormPreferences): Promise<void> {
    await AsyncStorage.setItem(CREATE_AGENT_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  }
}
