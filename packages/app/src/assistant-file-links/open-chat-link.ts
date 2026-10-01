import type { ChatLinkBehavior } from "@/hooks/use-settings";

export type InternalChatLinkLocation = "side" | "tab";

export interface OpenChatLinkInput {
  url: string;
  behavior: ChatLinkBehavior;
  askToOpenInternal(): Promise<boolean>;
  openInternal(url: string, location: InternalChatLinkLocation): void;
  openExternal(url: string): Promise<void>;
}

export async function openChatLink(input: OpenChatLinkInput): Promise<void> {
  let behavior = input.behavior;
  if (behavior === "ask") {
    behavior = (await input.askToOpenInternal()) ? "internal-tab" : "external";
  }
  if (behavior === "external") {
    await input.openExternal(input.url);
    return;
  }
  input.openInternal(input.url, behavior === "internal-side" ? "side" : "tab");
}
