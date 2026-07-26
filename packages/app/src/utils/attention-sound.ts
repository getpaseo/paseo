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

function tonesForPreset(preset: AttentionSoundPreset): ToneSpec[] {
  switch (preset) {
    case "ping":
      return [
        {
          frequencyHz: 880,
          durationMs: 90,
          startOffsetMs: 0,
          gain: 0.12,
          type: "sine",
        },
        {
          frequencyHz: 1320,
          durationMs: 110,
          startOffsetMs: 70,
          gain: 0.1,
          type: "sine",
        },
      ];
    case "classic":
      return [
        {
          frequencyHz: 523.25,
          durationMs: 120,
          startOffsetMs: 0,
          gain: 0.11,
          type: "triangle",
        },
        {
          frequencyHz: 659.25,
          durationMs: 140,
          startOffsetMs: 100,
          gain: 0.1,
          type: "triangle",
        },
        {
          frequencyHz: 783.99,
          durationMs: 160,
          startOffsetMs: 220,
          gain: 0.09,
          type: "triangle",
        },
      ];
    case "soft":
    default:
      return [
        {
          frequencyHz: 660,
          durationMs: 160,
          startOffsetMs: 0,
          gain: 0.08,
          type: "sine",
        },
        {
          frequencyHz: 880,
          durationMs: 200,
          startOffsetMs: 90,
          gain: 0.06,
          type: "sine",
        },
      ];
  }
}

/**
 * Play a short in-app attention chime for banner / intrusive / sound-only paths.
 * OS bubble sound is handled by Electron Notification.silent, not this helper.
 */
export function playAttentionSound(preset: AttentionSoundPreset): void {
  if (isNative) {
    return;
  }
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    return;
  }

  try {
    const context = new AudioContextCtor();
    const tones = tonesForPreset(preset);
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
