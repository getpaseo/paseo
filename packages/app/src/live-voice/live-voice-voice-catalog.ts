import { FALLBACK_LIVE_VOICE_OPTIONS } from "@getpaseo/protocol/live-voice-voices";

function normalizeVoiceOptions(options: readonly string[]): string[] {
  const voices = options.map((voice) => voice.trim()).filter(Boolean);
  return Array.from(new Set(voices));
}

export function resolveLiveVoiceVoiceOptions(catalogs: readonly (readonly string[])[]): string[] {
  const availableCatalogs = catalogs
    .map(normalizeVoiceOptions)
    .filter((voices) => voices.length > 0);
  if (availableCatalogs.length === 0) {
    return [...FALLBACK_LIVE_VOICE_OPTIONS];
  }

  const [first, ...rest] = availableCatalogs;
  return rest.reduce((common, voices) => {
    const available = new Set(voices);
    return common.filter((voice) => available.has(voice));
  }, first ?? []);
}

export async function resolveLiveVoiceVoiceForCall(input: {
  selectedVoice: string | undefined;
  listVoices?: () => Promise<string[]>;
}): Promise<string | undefined> {
  const selectedVoice = input.selectedVoice?.trim();
  if (!selectedVoice) {
    return undefined;
  }

  let options: string[];
  try {
    options = input.listVoices ? await input.listVoices() : [...FALLBACK_LIVE_VOICE_OPTIONS];
  } catch {
    options = [...FALLBACK_LIVE_VOICE_OPTIONS];
  }
  return resolveLiveVoiceVoiceOptions([options]).includes(selectedVoice)
    ? selectedVoice
    : undefined;
}
