import type { TextInputChangeEventData, TextInputKeyPressEventData } from "react-native";
import { resolveNativeTerminalKey } from "./terminal-key-events";
import type { TerminalTextInputChange } from "./terminal-input.native";

// Composition metadata comes from patches/react-native+0.81.5.patch. Text changes
// own printable input and deletion; keypresses run before UIKit applies the edit.
export function createIosTerminalTextInputState() {
  let committedText = "";
  let submittedText: string | null = null;

  return {
    receiveKeyPress(event: TextInputKeyPressEventData): TerminalTextInputChange {
      if (event.isComposing) {
        return { data: "", shouldClear: false };
      }

      const terminalKey = resolveNativeTerminalKey(event.key);
      if (terminalKey) {
        return { data: "", key: terminalKey, shouldClear: true };
      }
      if (event.key === "Backspace" && event.isTextEmpty) {
        // An empty native buffer has no text-change event, but the terminal
        // may still contain text from history, completion, or an earlier focus.
        return { data: "\x7f", shouldClear: false };
      }
      if (event.key === "Enter" || event.key === "Return" || event.key === "return") {
        submittedText = committedText;
        return { data: "\r", shouldClear: true };
      }
      return { data: "", shouldClear: false };
    },
    receiveChange(event: TextInputChangeEventData): TerminalTextInputChange {
      if (event.isComposing) {
        return { data: "", shouldClear: false };
      }

      const text = event.text;
      if (submittedText !== null) {
        const lateSubmitText = `${submittedText}\n`;
        submittedText = null;
        if (text === lateSubmitText) {
          return { data: "", shouldClear: false };
        }
      }
      if (text.includes("\n") || text.includes("\r")) {
        return { data: "", shouldClear: true };
      }

      if (text.startsWith(committedText)) {
        const data = text.slice(committedText.length);
        committedText = text;
        return { data, shouldClear: false };
      }
      if (committedText.startsWith(text)) {
        const removed = Array.from(committedText.slice(text.length)).length;
        committedText = text;
        return { data: "\x7f".repeat(removed), shouldClear: false };
      }

      // An unrelated replacement cannot safely rewrite a PTY. Discard the
      // native editing context so it cannot disable subsequent Backspace.
      return { data: "", shouldClear: true };
    },
    reset(): void {
      committedText = "";
    },
  };
}
