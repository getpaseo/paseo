import type { OpenChatWebLink } from "@/utils/open-chat-url";
import type { AssistantFileLinkResolverConfig } from "./provider";

type WebUrlContext = Pick<
  AssistantFileLinkResolverConfig,
  "serverId" | "workspaceRoot" | "onOpenWebUrl"
>;

interface DispatchWebUrlInput {
  url: string;
  captured: WebUrlContext;
  current: WebUrlContext;
  openExternal: OpenChatWebLink;
}

export async function dispatchWebUrl(input: DispatchWebUrlInput): Promise<void> {
  if (
    input.current.serverId !== input.captured.serverId ||
    input.current.workspaceRoot !== input.captured.workspaceRoot ||
    input.current.onOpenWebUrl !== input.captured.onOpenWebUrl
  ) {
    return;
  }
  const open = input.captured.onOpenWebUrl ?? input.openExternal;
  await open(input.url);
}
