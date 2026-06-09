import { AsyncStorageCreateAgentPreferenceStorage } from "./storage";
import {
  DEFAULT_FORM_PREFERENCES,
  parseFormPreferences,
  type FormPreferences,
} from "./preferences";
import type { CreateAgentPreferenceStorage } from "./storage";

export type FormPreferenceUpdate =
  | Partial<FormPreferences>
  | ((current: FormPreferences) => FormPreferences);

export class CreateAgentPreferencesService {
  private preferences: FormPreferences = DEFAULT_FORM_PREFERENCES;
  private isLoaded = false;
  private loadPromise: Promise<FormPreferences> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: CreateAgentPreferenceStorage) {}

  async load(): Promise<FormPreferences> {
    if (this.isLoaded) {
      return this.preferences;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.storage.read().then((stored) => {
        this.preferences = parseFormPreferences(stored);
        this.isLoaded = true;
        return this.preferences;
      });
    }
    return this.loadPromise;
  }

  async update(update: FormPreferenceUpdate): Promise<FormPreferences> {
    const previousWrite = this.writeQueue;
    const operation = this.applyQueuedUpdate(previousWrite, update);

    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyQueuedUpdate(
    previousWrite: Promise<void>,
    update: FormPreferenceUpdate,
  ): Promise<FormPreferences> {
    await previousWrite;
    const current = await this.load();
    const next = typeof update === "function" ? update(current) : { ...current, ...update };
    this.preferences = parseFormPreferences(next);
    this.isLoaded = true;
    await this.storage.write(this.preferences);
    return this.preferences;
  }
}

export const createAgentPreferencesService = new CreateAgentPreferencesService(
  new AsyncStorageCreateAgentPreferenceStorage(),
);
