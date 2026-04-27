// Resolves the auth-server URL for the renderer (React app).
//
// In dev (`__DEV__`) the default is localhost:3002 so the local auth-server
// works out of the box. In packaged builds the default is auth.hubcode.ai
// (production). Override via `EXPO_PUBLIC_HUBCODE_AUTH_URL` to point a dev
// build at a different auth-server — useful for testing the desktop locally
// against production hubcode.ai without spinning up a local auth-server.
//
// Expo inlines `process.env.EXPO_PUBLIC_*` at bundle time, so this works in
// both web and native builds with no runtime branching.

export function resolveAuthServerUrl(): string {
  const override = process.env.EXPO_PUBLIC_HUBCODE_AUTH_URL;
  if (override && override.length > 0) return override.replace(/\/$/, "");
  if (typeof __DEV__ !== "undefined" && __DEV__) return "http://localhost:3002";
  return "https://auth.hubcode.ai";
}
