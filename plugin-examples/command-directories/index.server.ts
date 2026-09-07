import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listCommands, resolveCommand } from "./server/commands";
import { listCommandsRpc, resolveCommandRpc } from "./shared/commands";

export default function contribute(server: PluginServerContext) {
  server.handle(listCommandsRpc, listCommands);
  server.handle(resolveCommandRpc, resolveCommand);
  return () => {};
}
