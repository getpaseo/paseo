import type { ChatLinkBehavior } from "@/hooks/use-settings/storage";
import { isHttpUrl } from "./http-url";

export type OpenChatWebLink = (url: string) => Promise<void>;

interface OpenChatUrlOptions {
  behavior: ChatLinkBehavior;
  openInBrowser: ((url: string) => void | Promise<void>) | undefined;
  openExternal: OpenChatWebLink;
}

export async function openChatUrl(url: string, options: OpenChatUrlOptions): Promise<void> {
  if (!isHttpUrl(url)) return;
  if (options.behavior === "in-app" && options.openInBrowser) {
    await options.openInBrowser(url);
    return;
  }
  await options.openExternal(url);
}
