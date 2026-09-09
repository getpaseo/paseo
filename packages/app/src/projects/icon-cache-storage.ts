import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ProjectIconCacheStorage } from "./icon-cache";

export const projectIconCacheStorage: ProjectIconCacheStorage = AsyncStorage;
