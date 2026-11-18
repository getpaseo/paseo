import type {
  HardwareKeyboardSubmitChord,
  HardwareKeyboardSubmitKeys,
} from "@/native/android-hardware-keyboard-submit.types";

export interface HardwareKeyboardSubmitListenerPort {
  addListener(handler: () => void): { remove: () => void };
  setEnabled(enabled: boolean): void;
}

export interface HardwareKeyboardSubmitController {
  setOnSubmit(handler: () => void): void;
  enable(): void;
  disable(): void;
}

export function createHardwareKeyboardSubmitController(
  port: HardwareKeyboardSubmitListenerPort,
): HardwareKeyboardSubmitController {
  let subscription: { remove: () => void } | null = null;
  let onSubmit: () => void = () => {};

  return {
    setOnSubmit(handler) {
      onSubmit = handler;
    },
    enable() {
      if (subscription) return;
      subscription = port.addListener(() => onSubmit());
      port.setEnabled(true);
    },
    disable() {
      if (!subscription) return;
      port.setEnabled(false);
      subscription.remove();
      subscription = null;
    },
  };
}

/** A key source that takes the published Return chords from the composer's text control. */
export interface HardwareKeyboardSubmitChordPort {
  addListener(handler: (keys: HardwareKeyboardSubmitKeys) => void): { remove: () => void };
  setChords(chords: readonly HardwareKeyboardSubmitChord[]): void;
}

export interface HardwareKeyboardSubmitChordController {
  setOnSubmit(handler: (keys: HardwareKeyboardSubmitKeys) => void): void;
  /** Publishes the chords the composer sends with. An empty list leaves Return with the text control. */
  setChords(chords: readonly HardwareKeyboardSubmitChord[]): void;
}

export function createHardwareKeyboardSubmitChordController(
  port: HardwareKeyboardSubmitChordPort,
): HardwareKeyboardSubmitChordController {
  let subscription: { remove: () => void } | null = null;
  let onSubmit: (keys: HardwareKeyboardSubmitKeys) => void = () => {};
  let published = "";

  return {
    setOnSubmit(handler) {
      onSubmit = handler;
    },
    setChords(chords) {
      const next = chords.join(" ");
      if (next === published) return;
      published = next;
      if (chords.length === 0) {
        port.setChords([]);
        subscription?.remove();
        subscription = null;
        return;
      }
      if (!subscription) {
        subscription = port.addListener((keys) => onSubmit(keys));
      }
      port.setChords(chords);
    },
  };
}
