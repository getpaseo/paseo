import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@paseo:plugin-timeline-expected";

/** Persists the hosts that replaced timeline rows across launches. */
export interface PluginTimelineExpectationStorage {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
}

export const pluginTimelineExpectationStorage: PluginTimelineExpectationStorage = {
  read: () => AsyncStorage.getItem(STORAGE_KEY),
  write: (raw) => AsyncStorage.setItem(STORAGE_KEY, raw),
};
