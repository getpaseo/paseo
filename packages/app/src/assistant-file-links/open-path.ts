import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkResolverContextValue } from "./provider";

export async function dispatchFileTarget(input: {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  if (await input.context.openDirectory(input.target.path)) return;
  const latest = input.context.configRef.current;
  if (
    latest.serverId !== input.capturedServerId ||
    latest.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  latest.onOpenWorkspaceFile?.(input.target, input.disposition);
}
