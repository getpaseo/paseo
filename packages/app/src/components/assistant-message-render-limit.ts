import { clampToSafeRevealBoundary, isTextRevealPacingSupported } from "@/agent-stream/text-reveal";

export const ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT = 32_000;

export interface CappedAssistantMessage {
  text: string;
  capped: boolean;
}

export function getUtf8ByteLength(message: string): number {
  let bytes = 0;

  for (let index = 0; index < message.length; index += 1) {
    const codeUnit = message.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < message.length &&
      message.charCodeAt(index + 1) >= 0xdc00 &&
      message.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

export function capAssistantMessageForRender(message: string): CappedAssistantMessage {
  if (message.length <= ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT) {
    return { text: message, capped: false };
  }

  let end = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;
  if (isTextRevealPacingSupported()) {
    end = clampToSafeRevealBoundary(message, end);
  } else {
    const finalCodeUnit = message.charCodeAt(end - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      end -= 1;
    }
  }

  return { text: message.slice(0, end), capped: true };
}
