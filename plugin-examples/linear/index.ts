import type { PluginContext } from "@getpaseo/plugin";
import { searchIssues } from "./issues.server";
import { issueAttachments, searchIssuesRpc } from "./issues.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(searchIssuesRpc, searchIssues);
  plugin.addAttachmentSource(issueAttachments);
  return () => {};
}
