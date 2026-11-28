import { redirectShareIntakePath } from "@/share-intake/model";

// Expo Router passes every incoming native URL through here before matching it to a route.
export function redirectSystemPath(input: { path: string; initial: boolean }): string | null {
  return redirectShareIntakePath(input);
}
