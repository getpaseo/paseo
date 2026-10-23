import { z } from "zod";

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.1;
export const PITCH_MIN = -6;
export const PITCH_MAX = 6;

export const VoiceSettingsSchema = z.object({
  speed: z.number().min(SPEED_MIN).max(SPEED_MAX),
  pitch: z.number().min(PITCH_MIN).max(PITCH_MAX),
  preset: z.string().nullable(),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export const VoiceSettingsPatchSchema = VoiceSettingsSchema.partial();
export type VoiceSettingsPatch = z.infer<typeof VoiceSettingsPatchSchema>;

export const VoiceCapabilitiesSchema = z.object({
  speed: z.boolean(),
  pitch: z.boolean(),
  presets: z.array(z.string()),
});
export type VoiceCapabilities = z.infer<typeof VoiceCapabilitiesSchema>;

export const DEFAULT_SETTINGS: VoiceSettings = { speed: 1, pitch: 0, preset: null };
export const DEFAULT_CAPABILITIES: VoiceCapabilities = { speed: true, pitch: false, presets: [] };

export const TimedWordSchema = z.object({
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type TimedWord = z.infer<typeof TimedWordSchema>;

export const UtteranceSchema = z.object({
  id: z.string(),
  text: z.string(),
  words: z.array(TimedWordSchema),
  startedAt: z.number(),
});
export type Utterance = z.infer<typeof UtteranceSchema>;

export function clampSettings(
  current: VoiceSettings,
  patch: VoiceSettingsPatch,
  capabilities: VoiceCapabilities,
): VoiceSettings {
  const speed = capabilities.speed && patch.speed !== undefined ? patch.speed : current.speed;
  const pitch = capabilities.pitch && patch.pitch !== undefined ? patch.pitch : current.pitch;
  const wanted = patch.preset === undefined ? current.preset : patch.preset;
  const preset = wanted === null || capabilities.presets.includes(wanted) ? wanted : current.preset;
  return {
    speed: Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)) * 100) / 100,
    pitch: Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch)),
    preset,
  };
}

export function activeWordIndex(words: readonly TimedWord[], elapsedSeconds: number): number {
  if (elapsedSeconds < 0) return -1;
  return words.findIndex((entry) => entry.start <= elapsedSeconds && elapsedSeconds <= entry.end);
}

export function parseLastUtterance(text: string): Utterance | null {
  const lines = text.split("\n").filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let json: unknown;
    try {
      json = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const parsed = UtteranceSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  }
  return null;
}
