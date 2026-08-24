import Constants from "expo-constants";

/** F-Droid build without proprietary camera or notification dependencies. */
export const isFdroidBuild = Constants.expoConfig?.extra?.fdroidBuild === true;

/** Production-like Android build with local profiling enabled. */
export const isProfileBuild = Constants.expoConfig?.extra?.profileBuild === true;
