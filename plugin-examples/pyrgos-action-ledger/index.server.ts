import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listActionItems } from "./server/list-items";
import { listActionItemsRpc } from "./shared/list-rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(listActionItemsRpc, listActionItems);
  return () => {};
}
