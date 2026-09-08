import type { PluginClientContext } from "@getpaseo/plugin/client";
import { issueAttachments } from "./shared/issues";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(issueAttachments);
  return () => {};
}
