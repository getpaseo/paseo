/**
 * Plays a short notification chime using the Web Audio API.
 *
 * Generates a 3-note ascending arpeggio (C5 → E5 → G5) over ~500ms.
 * Gracefully no-ops in environments without `window.AudioContext` (SSR, native mobile).
 * Uses a lazily-initialized singleton AudioContext to avoid hitting browser
 * concurrent-context limits and to inherit the "allowed to play" state from
 * prior user interaction.
 */

let cachedContext: AudioContext | null = null;
let contextFailed = false;

function getAudioContext(): AudioContext | null {
  if (contextFailed) return null;
  if (cachedContext) return cachedContext;

  if (typeof window === "undefined") return null;
  const AudioContextCtor =
    window.AudioContext ??
    ((window as Record<string, unknown>).webkitAudioContext as typeof AudioContext | undefined);
  if (!AudioContextCtor) return null;

  try {
    cachedContext = new AudioContextCtor();
  } catch {
    contextFailed = true;
    return null;
  }

  return cachedContext;
}

export function playNotificationSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Ensure the context is running (handle autoplay policy). Fire-and-forget:
  // if resume fails the scheduled notes simply won't be audible.
  const scheduleChime = (): void => {
    try {
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
      const noteDuration = 0.15;
      const gap = 0.02;
      const now = ctx.currentTime;
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0.3;
      masterGain.connect(ctx.destination);

      for (let i = 0; i < notes.length; i++) {
        const osc = ctx.createOscillator();
        const noteGain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = notes[i];
        const startTime = now + i * (noteDuration + gap);
        noteGain.gain.setValueAtTime(0, startTime);
        noteGain.gain.linearRampToValueAtTime(0.3, startTime + 0.01);
        noteGain.gain.setValueAtTime(0.3, startTime + noteDuration - 0.03);
        noteGain.gain.linearRampToValueAtTime(0, startTime + noteDuration);
        osc.connect(noteGain);
        noteGain.connect(masterGain);
        osc.start(startTime);
        osc.stop(startTime + noteDuration);
      }
    } catch {
      // Best-effort: silently ignore failures
    }
  };

  if (ctx.state === "suspended") {
    ctx.resume().then(scheduleChime).catch(() => {});
  } else {
    scheduleChime();
  }
}
