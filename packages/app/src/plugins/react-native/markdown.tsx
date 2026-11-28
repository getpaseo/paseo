import type { MarkdownProps } from "@getpaseo/plugin/client/ui";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePluginInstallationServerId } from "../installation-provider";

export function Markdown({ children }: MarkdownProps) {
  const serverId = usePluginInstallationServerId();
  const runtimeClient = useHostRuntimeClient(serverId ?? "");
  if (!children) return null;

  const client = runtimeClient?.readFile ? runtimeClient : null;
  return <MarkdownRenderer text={children} {...(serverId ? { serverId, client } : {})} />;
}
