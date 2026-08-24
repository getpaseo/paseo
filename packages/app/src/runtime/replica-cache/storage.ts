import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ReplicaCacheStorage } from "./index";

export const replicaCacheStorage: ReplicaCacheStorage = AsyncStorage;
