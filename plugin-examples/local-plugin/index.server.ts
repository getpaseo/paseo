import type { PluginServerContext } from "@getpaseo/plugin";
import { increment } from "./server/increment";
import { incrementRpc } from "./shared/increment";

export default function contribute(server: PluginServerContext) {
  server.handle(incrementRpc, increment);
  return () => {};
}
