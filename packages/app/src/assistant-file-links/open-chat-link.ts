import type { ChatLinkBehavior } from "@/hooks/use-settings";

export type InternalChatLinkLocation = "side" | "tab";
export type ChatLinkAskResult = "internal-tab" | "external" | null;

export interface OpenChatLinkInput {
  url: string;
  behavior: ChatLinkBehavior;
  askHowToOpen(): Promise<ChatLinkAskResult>;
  openInternal(url: string, location: InternalChatLinkLocation): void;
  openExternal(url: string): Promise<void>;
}

export async function openChatLink(input: OpenChatLinkInput): Promise<void> {
  let behavior = input.behavior;
  if (behavior === "ask") {
    const choice = await input.askHowToOpen();
    if (choice === null) return;
    behavior = choice;
  }
  if (behavior === "external") {
    await input.openExternal(input.url);
    return;
  }
  input.openInternal(input.url, behavior === "internal-side" ? "side" : "tab");
}

export function resolveChatLinkDialogChoice(choice: number | null): ChatLinkAskResult {
  if (choice === 1) return "external";
  if (choice === 2) return "internal-tab";
  return null;
}
