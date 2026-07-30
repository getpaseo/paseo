export interface TtsSegment {
  index: number;
  text: string;
}

export const MAX_TTS_SEGMENT_CHARS = 260;

function splitOversizedFragment(fragment: string, maxChars: number): string[] {
  const trimmed = fragment.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const clauseChunks = trimmed.split(/(?<=[,;:])\s+/);
  if (clauseChunks.length > 1) {
    const parts: string[] = [];
    let current = "";

    const pushCurrent = () => {
      const value = current.trim();
      if (value) {
        parts.push(value);
      }
      current = "";
    };

    for (const clause of clauseChunks) {
      const clauseText = clause.trim();
      if (!clauseText) {
        continue;
      }

      if (clauseText.length > maxChars) {
        pushCurrent();
        parts.push(...splitOversizedFragment(clauseText, maxChars));
        continue;
      }

      if (!current) {
        current = clauseText;
        continue;
      }

      const candidate = `${current} ${clauseText}`;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      pushCurrent();
      current = clauseText;
    }

    pushCurrent();
    if (parts.length > 1 || parts[0] !== trimmed) {
      return parts;
    }
  }

  const parts: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxChars) {
    let idx = remaining.lastIndexOf(" ", maxChars);
    if (idx < Math.floor(maxChars * 0.5)) {
      idx = maxChars;
    }
    parts.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

/**
 * Split text into sentence-ish segments small enough to synthesize with low
 * latency. Segments are the unit of streaming for both voice mode and read
 * aloud: the first segment can play while later ones are still synthesizing.
 */
export function splitTextForTts(text: string): TtsSegment[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Cannot synthesize empty text");
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const parts: TtsSegment[] = [];
  let segmentIndex = 0;

  for (const sentence of sentences) {
    const fragments = splitOversizedFragment(sentence, MAX_TTS_SEGMENT_CHARS);
    for (const fragment of fragments) {
      parts.push({ index: segmentIndex, text: fragment });
      segmentIndex += 1;
    }
  }

  return parts;
}
