/** Commands must occupy the entire utterance; quoting them inside dictation is safe. */
export function parseVoiceInputCommand(transcript: string): "mute" | "unmute" | null {
  const normalized = normalize(transcript);
  if (normalized === "mute microphone") return "mute";
  if (normalized === "unmute microphone" || normalized === "un mute microphone") return "unmute";
  return null;
}

/** Delay barge-in for a possible command until its final transcript arrives. */
export function isVoiceInputCommandPrefix(transcript: string): boolean {
  const normalized = normalize(transcript);
  return (
    normalized.length > 0 &&
    ["mute microphone", "unmute microphone", "un mute microphone"].some((command) =>
      command.startsWith(normalized),
    )
  );
}

function normalize(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
