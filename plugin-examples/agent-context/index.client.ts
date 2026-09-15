import type { PluginClientContext } from "@getpaseo/plugin/client";
import { agentTranscriptAttachments } from "./shared/agent-context";

export default function contribute(client: PluginClientContext) {
  return client.addAttachmentSource(agentTranscriptAttachments);
}
