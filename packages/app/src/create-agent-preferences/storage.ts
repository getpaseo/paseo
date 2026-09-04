import { layeredSettingsStorage } from "@/storage/settings-seed";
import { readValidatedJson } from "@/storage/validated-storage";
import {
  FormPreferencesSchema,
  StoredFormPreferencesSchema,
  type FormPreferences,
} from "./preferences";

export const CREATE_AGENT_PREFERENCES_STORAGE_KEY = "@paseo:create-agent-preferences";

export interface CreateAgentPreferenceStorage {
  read(): Promise<unknown>;
  write(preferences: FormPreferences): Promise<void>;
}

export class AsyncStorageCreateAgentPreferenceStorage implements CreateAgentPreferenceStorage {
  async read(): Promise<unknown> {
    return readValidatedJson(
      layeredSettingsStorage,
      CREATE_AGENT_PREFERENCES_STORAGE_KEY,
      StoredFormPreferencesSchema,
    );
  }

  async write(preferences: FormPreferences): Promise<void> {
    const result = FormPreferencesSchema.safeParse(preferences);
    if (!result.success) {
      await layeredSettingsStorage.removeItem(CREATE_AGENT_PREFERENCES_STORAGE_KEY);
      return;
    }
    await layeredSettingsStorage.setItem(
      CREATE_AGENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(result.data),
    );
  }
}
