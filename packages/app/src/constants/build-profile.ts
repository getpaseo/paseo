import Constants from "expo-constants";

/** F-Droid build without proprietary camera, notification, or OTA dependencies. */
export const isFdroidBuild = Constants.expoConfig?.extra?.fdroidBuild === true;
