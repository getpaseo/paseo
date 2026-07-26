import type { ProjectIcon } from "@getpaseo/protocol/messages";

const PROJECT_EMOJI_DATA_URI_PREFIX = "data:application/vnd.paseo.project-emoji,";

export function projectIconToDataUri(icon: ProjectIcon | null): string | null {
  if (!icon) {
    return null;
  }
  if (icon.emoji) {
    return `${PROJECT_EMOJI_DATA_URI_PREFIX}${encodeURIComponent(icon.emoji)}`;
  }
  return `data:${icon.mimeType};base64,${icon.data}`;
}

export function projectIconEmojiFromDataUri(dataUri: string | null): string | null {
  if (!dataUri?.startsWith(PROJECT_EMOJI_DATA_URI_PREFIX)) {
    return null;
  }
  try {
    return decodeURIComponent(dataUri.slice(PROJECT_EMOJI_DATA_URI_PREFIX.length));
  } catch {
    return null;
  }
}
