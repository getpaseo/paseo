import type { AttentionSoundPreset } from "@/hooks/use-settings/storage";
import { isNative } from "@/constants/platform";

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof globalThis === "undefined") {
    return null;
  }
  const g = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

interface ToneSpec {
  frequencyHz: number;
  durationMs: number;
  startOffsetMs: number;
  gain: number;
  type: OscillatorType;
}

/**
 * Synthesized notification chimes — short, distinct, office/coding friendly.
 * No external audio assets; works on web/Electron without packaging WAV files.
 */
function tonesForPreset(preset: AttentionSoundPreset): ToneSpec[] {
  switch (preset) {
    case "chime":
      // Soft ascending triple — polite "ready to review"
      return [
        { frequencyHz: 523.25, durationMs: 140, startOffsetMs: 0, gain: 0.08, type: "sine" },
        { frequencyHz: 659.25, durationMs: 150, startOffsetMs: 90, gain: 0.075, type: "sine" },
        { frequencyHz: 783.99, durationMs: 180, startOffsetMs: 190, gain: 0.07, type: "sine" },
      ];
    case "ping":
      // Sharp double ping — classic IM-style attention
      return [
        { frequencyHz: 880, durationMs: 90, startOffsetMs: 0, gain: 0.12, type: "sine" },
        { frequencyHz: 1320, durationMs: 110, startOffsetMs: 70, gain: 0.1, type: "sine" },
      ];
    case "glass":
      // High crystalline tick
      return [
        { frequencyHz: 1568, durationMs: 70, startOffsetMs: 0, gain: 0.07, type: "triangle" },
        { frequencyHz: 2093, durationMs: 120, startOffsetMs: 40, gain: 0.055, type: "sine" },
      ];
    case "knock":
      // Low double knock — subdued desk attention
      return [
        { frequencyHz: 180, durationMs: 70, startOffsetMs: 0, gain: 0.14, type: "triangle" },
        { frequencyHz: 160, durationMs: 90, startOffsetMs: 110, gain: 0.12, type: "triangle" },
      ];
    case "pulse":
      // Mid rhythmic two-beat
      return [
        { frequencyHz: 440, durationMs: 100, startOffsetMs: 0, gain: 0.1, type: "sine" },
        { frequencyHz: 440, durationMs: 120, startOffsetMs: 140, gain: 0.09, type: "sine" },
      ];
    case "bell":
      // Classic triple bell (was "classic")
      return [
        { frequencyHz: 523.25, durationMs: 120, startOffsetMs: 0, gain: 0.11, type: "triangle" },
        { frequencyHz: 659.25, durationMs: 140, startOffsetMs: 100, gain: 0.1, type: "triangle" },
        { frequencyHz: 783.99, durationMs: 160, startOffsetMs: 220, gain: 0.09, type: "triangle" },
      ];
    case "drop":
      // Descending drop — "something finished"
      return [
        { frequencyHz: 740, durationMs: 100, startOffsetMs: 0, gain: 0.1, type: "sine" },
        { frequencyHz: 554, durationMs: 140, startOffsetMs: 80, gain: 0.09, type: "sine" },
        { frequencyHz: 415, durationMs: 180, startOffsetMs: 180, gain: 0.08, type: "triangle" },
      ];
    case "spark":
      // Quick bright sparkle
      return [
        { frequencyHz: 1175, durationMs: 50, startOffsetMs: 0, gain: 0.09, type: "square" },
        { frequencyHz: 1568, durationMs: 60, startOffsetMs: 45, gain: 0.07, type: "sine" },
        { frequencyHz: 2093, durationMs: 80, startOffsetMs: 95, gain: 0.05, type: "sine" },
      ];
    case "alert":
      // Clear attention-grabbing pair
      return [
        { frequencyHz: 698, durationMs: 110, startOffsetMs: 0, gain: 0.11, type: "triangle" },
        { frequencyHz: 932, durationMs: 160, startOffsetMs: 100, gain: 0.1, type: "triangle" },
      ];
    case "soft":
    default:
      // Gentle two-tone default
      return [
        { frequencyHz: 660, durationMs: 160, startOffsetMs: 0, gain: 0.08, type: "sine" },
        { frequencyHz: 880, durationMs: 200, startOffsetMs: 90, gain: 0.06, type: "sine" },
      ];
  }
}

/** Map legacy preset ids stored before the 10-sound set. */
export function resolveAttentionSoundPreset(
  preset: string | null | undefined,
): AttentionSoundPreset {
  if (preset === "classic") {
    return "bell";
  }
  switch (preset) {
    case "soft":
    case "chime":
    case "ping":
    case "glass":
    case "knock":
    case "pulse":
    case "bell":
    case "drop":
    case "spark":
    case "alert":
      return preset;
    default:
      return "soft";
  }
}

/**
 * Play a short in-app attention chime for banner / intrusive / sound-only / preview paths.
 * OS bubble system sound is separate (and often not selectable); this is the curated set.
 */
export function playAttentionSound(preset: AttentionSoundPreset | string): void {
  if (isNative) {
    return;
  }
  const resolved = resolveAttentionSoundPreset(preset);
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    return;
  }

  try {
    const context = new AudioContextCtor();
    const tones = tonesForPreset(resolved);
    const now = context.currentTime;
    let maxEnd = 0;

    for (const tone of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.value = tone.frequencyHz;
      const start = now + tone.startOffsetMs / 1000;
      const end = start + tone.durationMs / 1000;
      maxEnd = Math.max(maxEnd, end);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }

    const closeAfterMs = Math.ceil((maxEnd - now) * 1000) + 80;
    setTimeout(() => {
      void context.close().catch(() => {});
    }, closeAfterMs);
  } catch {
    // Audio can fail before user gesture on some platforms; ignore.
  }
}
