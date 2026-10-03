import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contextAttachments } from "./shared/context";

export default function contribute(client: PluginClientContext) {
  return client.addAttachmentSource(contextAttachments);
}
