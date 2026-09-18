import type { AgentPromptInput } from "../../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";

export interface MuseTurnInputPart {
  type: "text";
  text: string;
}

export interface MuseTurnImagePart {
  type: "image";
  base64Data: string;
  mediaType: string;
}

export type MuseTurnPart = MuseTurnInputPart | MuseTurnImagePart;

export interface MuseTurnPayload {
  /** Model-visible input parts for `turn/start`. */
  parts: MuseTurnPart[];
  /** Transcript presentation form; never model-visible. */
  displayText: string;
  /** Plain-text form of the user's prompt (no system prefix). */
  text: string;
}

/**
 * Convert a Paseo prompt to MSP turn input. File mentions are `@path` text
 * (MSP has no file part type); images ride as native image parts. An optional
 * system prefix is prepended to the model-visible text only — `displayText`
 * keeps the transcript clean. MSP 1.2.1 has no native system-prompt channel.
 */
export function convertMusePromptInput(
  prompt: AgentPromptInput,
  options?: { systemPrefix?: string },
): MuseTurnPayload {
  const textParts: string[] = [];
  const parts: MuseTurnPart[] = [];
  if (typeof prompt === "string") {
    textParts.push(prompt);
    parts.push({ type: "text", text: prompt });
  } else {
    for (const block of prompt) {
      if (block.type === "text") {
        textParts.push(block.text);
        parts.push({ type: "text", text: block.text });
        continue;
      }
      if (block.type === "image") {
        parts.push({ type: "image", base64Data: block.data, mediaType: block.mimeType });
        continue;
      }
      const rendered = renderPromptAttachmentAsText(block);
      textParts.push(rendered);
      parts.push({ type: "text", text: rendered });
    }
  }
  const text = textParts.join("\n\n");
  const systemPrefix = options?.systemPrefix?.trim();
  if (systemPrefix) {
    parts.unshift({ type: "text", text: systemPrefix });
  }
  return {
    parts,
    displayText: text,
    text,
  };
}
