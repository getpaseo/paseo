/** Live text is read by editing consumers; containers subscribe only to what they display. */
export interface ComposerTextSource {
  getSnapshot: () => string;
  subscribe: (listener: () => void) => () => void;
}
