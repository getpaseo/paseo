import { createServerFn } from "@tanstack/react-start";
import { getWebsiteCacheContext } from "./cloudflare-cache";
import { getLatestReleaseInfo } from "./latest-release";

export const getLatestRelease = createServerFn({ method: "GET" }).handler(async () => {
  return getLatestReleaseInfo(getWebsiteCacheContext());
});
