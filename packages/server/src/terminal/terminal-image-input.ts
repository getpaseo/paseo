import { TerminalImageError } from "@getpaseo/protocol/terminal-image-error";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";
import {
  terminalImageReference,
  type TerminalImageInput,
  type TerminalImageStore,
} from "../server/host-clipboard.js";
import type { TerminalManager } from "./terminal-manager.js";
import { TerminalPasteQueue } from "@getpaseo/protocol/terminal-paste-queue";
import type { TerminalSession } from "./terminal.js";

// Shared by all sessions observing this PTY. Resize and output never enter this queue.
const queues = new WeakMap<TerminalSession, TerminalPasteQueue>();
export function terminalImageInput(terminal: TerminalSession): TerminalPasteQueue {
  let queue = queues.get(terminal);
  if (!queue) {
    queue = new TerminalPasteQueue({ timeoutMs: 10_000 });
    queues.set(terminal, queue);
    terminal.onExit(() => queue?.dispose());
  }
  return queue;
}

export async function pasteTerminalImage(options: {
  terminal: TerminalSession;
  manager: TerminalManager;
  store: Pick<TerminalImageStore, "save">;
  image: TerminalImageInput;
  signal: AbortSignal;
}): Promise<void> {
  const { terminal, manager, store, image } = options;
  let failure: unknown;
  const completed = await terminalImageInput(terminal).paste(async (signal) => {
    try {
      const assertActive = () => {
        if (signal.aborted || options.signal.aborted)
          throw new TerminalImageError("upload_failed", "Image paste cancelled");
      };
      assertActive();
      const snapshot = await manager.getTerminalState(terminal.id, { scrollbackLines: 0 });
      if (!snapshot)
        throw new TerminalImageError(
          "terminal_closed",
          "Terminal closed before image paste completed",
        );
      assertActive();
      const modes = new TerminalInputModeTracker();
      modes.feed(snapshot.replayPreamble ?? terminal.getReplayPreamble());
      if (!modes.getState().bracketedPaste)
        throw new TerminalImageError(
          "unsupported_mode",
          "Image paste requires an agent that accepts bracketed file paste",
        );
      const path = await store.save(image);
      if (manager.getTerminal(terminal.id) !== terminal || terminal.getExitInfo())
        throw new TerminalImageError(
          "terminal_closed",
          "Terminal closed before image paste completed",
        );
      assertActive();
      await terminal.paste(terminalImageReference(path));
      return true;
    } catch (error) {
      failure = error;
      return false;
    }
  });
  if (!completed)
    throw failure ?? new TerminalImageError("upload_failed", "Image paste cancelled or timed out");
}
