/**
 * App-wide signal for user input that native clients cannot observe through DOM
 * events: touches on the app root and edits in native text inputs.
 *
 * Every host session subscribes, so one touch keeps the device present for all
 * connected daemons.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function reportNativeUserActivity(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeNativeUserActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
