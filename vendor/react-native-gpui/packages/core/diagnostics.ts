import { AppState } from 'react-native';

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = {
  getGlobalHandler?: () => ErrorHandler | undefined;
  setGlobalHandler?: (handler: ErrorHandler) => void;
};

let enabled = false;

/**
 * Writes uncaught JS errors and AppState changes to the console with a
 * timestamp, to trace a window that goes blank after a long time in the
 * background. Off unless an app calls it: an uncaught error is otherwise
 * reported twice, and every focus change adds a console line.
 */
export function enableDiagnostics(): void {
  if (enabled || __DEV__ === false) {
    return;
  }
  enabled = true;
  const stamp = () => new Date().toISOString();
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (utils && typeof utils.setGlobalHandler === 'function') {
    const previous = utils.getGlobalHandler && utils.getGlobalHandler();
    utils.setGlobalHandler((error, isFatal) => {
      const detail = error as { stack?: string; message?: string } | null;
      console.error(
        `[rn-gpui] ${stamp()} ${isFatal ? 'fatal' : 'non-fatal'} JS error: ${
          (detail && (detail.stack || detail.message)) || String(error)
        }`,
      );
      if (previous) {
        previous(error, isFatal);
      }
    });
  }
  AppState.addEventListener('change', state =>
    console.log(`[rn-gpui] ${stamp()} app state -> ${state}`),
  );
}
