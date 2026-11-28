// The real module loads Expo's native runtime, which has no Node build. The plugin client
// runtime imports the image picker, so every test that loads plugins would fail to import.
export type MediaType = "images" | "videos" | "livePhotos";

const denied = { granted: false, status: "denied", canAskAgain: false, expires: "never" };

export async function getMediaLibraryPermissionsAsync() {
  return denied;
}
export async function requestMediaLibraryPermissionsAsync() {
  return denied;
}
export async function getPendingResultAsync() {
  return [];
}
export async function launchImageLibraryAsync() {
  return { canceled: true, assets: null };
}
