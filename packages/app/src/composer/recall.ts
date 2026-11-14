import type { ComposerKeyPressEvent } from "@/composer/input/input";

interface RecalledMessage {
  index: number;
  text: string;
}

/**
 * Walks the messages already sent to an agent from an empty composer, like a
 * shell's Up/Down history. A message stays recalled only while the composer
 * still holds its exact text; the first edit hands the arrows back to the caret.
 */
export class ComposerRecall {
  private recalled: RecalledMessage | null = null;

  /**
   * Stops treating the composer's text as recalled. Call it when the composer is
   * filled from elsewhere, such as a queued message taken back for editing, which
   * can hold the same text as the last recalled message; Down would clear it.
   */
  forget(): void {
    this.recalled = null;
  }

  /** True while the composer shows a recalled message the user has not edited. */
  isShowing(text: string): boolean {
    return this.recalled !== null && this.recalled.text === text;
  }

  /**
   * Returns the text the composer should show for this key press, or null to
   * leave the key to the input. `readSentMessages` is newest first and is only
   * read for keys recall acts on.
   */
  handleKeyPress(
    event: ComposerKeyPressEvent,
    readSentMessages: () => readonly string[],
  ): string | null {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
    if (event.hasModifier) return null;
    const { text, selection } = event.input;
    if (selection.start !== selection.end) return null;

    const recalled = this.isShowing(text) ? this.recalled : null;
    if (!recalled) {
      this.recalled = null;
      if (event.key !== "ArrowUp" || text.length > 0) return null;
      return this.show(readSentMessages(), 0);
    }

    if (event.key === "ArrowUp") {
      if (!isCaretOnFirstLine(text, selection.start)) return null;
      return this.show(readSentMessages(), recalled.index + 1);
    }
    if (!isCaretOnLastLine(text, selection.start)) return null;
    if (recalled.index === 0) {
      this.recalled = null;
      return "";
    }
    return this.show(readSentMessages(), recalled.index - 1);
  }

  private show(messages: readonly string[], index: number): string | null {
    const text = messages[index];
    if (text === undefined) return null;
    this.recalled = { index, text };
    return text;
  }
}

function isCaretOnFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes("\n");
}

function isCaretOnLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes("\n");
}

/**
 * Up in an empty composer edits the newest queued message, the same as its
 * Edit button, before recall walks the sent ones: it is the most recent thing
 * the user wrote, and queueing the last message again keeps the queue's order.
 * A draft, text or attachments, is never replaced.
 */
export function shouldEditNewestQueuedMessage(
  event: ComposerKeyPressEvent,
  composer: { queuedCount: number; hasAttachments: boolean },
): boolean {
  if (event.key !== "ArrowUp" || event.hasModifier) return false;
  if (composer.queuedCount === 0 || composer.hasAttachments) return false;
  const { text, selection } = event.input;
  return text.length === 0 && selection.start === selection.end;
}
