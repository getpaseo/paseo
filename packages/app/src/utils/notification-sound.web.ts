import { loadDesktopSettings } from "@/desktop/settings/desktop-settings";
import { NOTIFICATION_TONE_WAV_BASE64 } from "./notification-tone.base64";

const TONE_DATA_URI = `data:audio/wav;base64,${NOTIFICATION_TONE_WAV_BASE64}`;

let toneElement: HTMLAudioElement | null = null;

function getToneElement(): HTMLAudioElement | null {
  const AudioConstructor = (globalThis as { Audio?: typeof Audio }).Audio;
  if (typeof AudioConstructor !== "function") {
    return null;
  }
  if (!toneElement) {
    toneElement = new AudioConstructor(TONE_DATA_URI);
    toneElement.preload = "auto";
  }
  return toneElement;
}

/**
 * Plays the notification sound independently of the OS notification, so audio
 * still fires when the OS suppresses notifications (e.g. Windows with
 * notifications disabled). The desktop Notification is always created with
 * `silent: true` to keep this as the single sound source.
 */
export async function playNotificationSound(): Promise<boolean> {
  let shouldPlay = true;
  try {
    shouldPlay = (await loadDesktopSettings()).notifications.playSound;
  } catch {
    // Settings unavailable: fall back to the default (sound on).
  }
  if (!shouldPlay) {
    return false;
  }

  const element = getToneElement();
  if (!element) {
    return false;
  }
  try {
    element.pause();
    element.currentTime = 0;
    await element.play();
    return true;
  } catch {
    // Autoplay rejection or missing media support: never break the notification.
    return false;
  }
}
