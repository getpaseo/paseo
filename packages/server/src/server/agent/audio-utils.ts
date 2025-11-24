const AUDIO_EXTENSIONS: Array<{ match: (format: string) => boolean; ext: string }> = [
  { match: (format) => format.includes("webm"), ext: "webm" },
  { match: (format) => format.includes("ogg"), ext: "ogg" },
  { match: (format) => format.includes("mp3"), ext: "mp3" },
  { match: (format) => format.includes("wav"), ext: "wav" },
  { match: (format) => format.includes("m4a") || format.includes("aac"), ext: "m4a" },
  { match: (format) => format.includes("mp4"), ext: "mp4" },
  { match: (format) => format.includes("flac"), ext: "flac" },
];

export function inferAudioExtension(format: string | undefined): string {
  const normalized = (format || "webm").toLowerCase();
  const candidate = AUDIO_EXTENSIONS.find((entry) => entry.match(normalized));
  return candidate?.ext ?? "webm";
}

export function sanitizeForFilename(segment: string | undefined, fallback: string): string {
  const value = segment && segment.length > 0 ? segment : fallback;
  return value.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 64);
}
