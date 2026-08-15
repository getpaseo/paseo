import { isWeb } from "@/constants/platform";
import type { SelectedTextComposerAttachment } from "@/attachments/types";

const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"]';
const ASSISTANT_MESSAGE_ITEM_SELECTOR = '[data-testid^="assistant-message-item:"]';

export function scrollToSelectedText(
  attachment: SelectedTextComposerAttachment,
  scrollToMessage?: (messageId: string) => void,
): void {
  if (!isWeb) {
    return;
  }

  let didRequestMessageScroll = false;
  let attemptsRemaining = scrollToMessage ? 20 : 0;
  const focusSelection = () => {
    const message = findAssistantMessage(attachment);
    if (!message) {
      if (attachment.sourceMessageId && scrollToMessage && !didRequestMessageScroll) {
        didRequestMessageScroll = true;
        scrollToMessage(attachment.sourceMessageId);
      }
      if (attemptsRemaining > 0) {
        attemptsRemaining -= 1;
        window.requestAnimationFrame(focusSelection);
      }
      return;
    }

    message.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  focusSelection();
}

function findAssistantMessage(attachment: SelectedTextComposerAttachment): Element | null {
  const messageItems = Array.from(
    document.querySelectorAll<HTMLElement>(ASSISTANT_MESSAGE_ITEM_SELECTOR),
  );
  if (attachment.sourceMessageId) {
    const source = messageItems.find(
      (item) => item.dataset.testid === `assistant-message-item:${attachment.sourceMessageId}`,
    );
    if (source) {
      return source.querySelector(ASSISTANT_MESSAGE_SELECTOR);
    }
  }

  const preview = attachment.text.replace(/\s+/g, " ").trim();
  return (
    messageItems
      .map((item) => item.querySelector(ASSISTANT_MESSAGE_SELECTOR))
      .find((message) => message?.textContent?.replace(/\s+/g, " ").includes(preview)) ?? null
  );
}
