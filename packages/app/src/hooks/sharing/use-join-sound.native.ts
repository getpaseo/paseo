// Native stub — the join-sound feature is web-only for now. Native apps will
// get a proper notification sound via expo-av when we ship the in-app shared
// session UI to mobile.
export function useJoinSound(): void {
  // no-op on native
}
