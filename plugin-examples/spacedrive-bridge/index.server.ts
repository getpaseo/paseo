import type { PluginServerContext } from "@getpaseo/plugin/server";
import { spacedriveCopyToLocal, spacedriveSearch, spacedriveStatus } from "./shared/spacedrive.js";
import { copyToLocal, search, status } from "./server/bridge.js";

export default function contribute(server: PluginServerContext) {
  server.handle(spacedriveStatus, () => status());
  server.handle(spacedriveSearch, ({ libraryId, query, limit }) => search(libraryId, query, limit));
  server.handle(spacedriveCopyToLocal, (input) => copyToLocal(input));
  return async () => {};
}
