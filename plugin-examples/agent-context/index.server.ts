import type { PluginServerContext } from "@getpaseo/plugin/server";
import { searchAgentTranscripts } from "./server/agent-context";
import { searchAgentTranscriptsRpc } from "./shared/agent-context";

export default function contribute(server: PluginServerContext) {
  server.handle(searchAgentTranscriptsRpc, searchAgentTranscripts);
  return () => {};
}
