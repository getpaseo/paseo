import AsyncStorage from "@react-native-async-storage/async-storage";
import { readValidatedJson } from "@/storage/validated-storage";
import { FormPreferencesSchema, type FormPreferences } from "./preferences";

export const CREATE_AGENT_PREFERENCES_STORAGE_KEY = "@paseo:create-agent-preferences";

export interface CreateAgentPreferenceStorage {
  read(): Promise<unknown>;
  write(preferences: FormPreferences): Promise<void>;
}

export class AsyncStorageCreateAgentPreferenceStorage implements CreateAgentPreferenceStorage {
  async read(): Promise<unknown> {
    return readValidatedJson(
      AsyncStorage,
      CREATE_AGENT_PREFERENCES_STORAGE_KEY,
      FormPreferencesSchema,
    );
  }

  async write(preferences: FormPreferences): Promise<void> {
    const result = FormPreferencesSchema.safeParse(preferences);
    if (!result.success) {
      await AsyncStorage.removeItem(CREATE_AGENT_PREFERENCES_STORAGE_KEY);
      return;
    }
    await AsyncStorage.setItem(CREATE_AGENT_PREFERENCES_STORAGE_KEY, JSON.stringify(result.data));
  }
}
