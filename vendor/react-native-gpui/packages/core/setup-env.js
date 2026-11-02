// RN 0.87's development setup expects the browser `window` global. A JS engine
// on the desktop only has `globalThis`, so provide the alias before the stock
// RN setup.
// This file is loaded by the CLI before the app entry module.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

module.exports = require('react-native/setup-env');

// Dev diagnostics: a window that goes blank after a long time in the background
// leaves no trace unless the errors that unmount the tree, and the app's own
// state changes around them, are written to the log.
if (globalThis.__DEV__ !== false && !globalThis.__rnGpuiDiagnostics) {
  globalThis.__rnGpuiDiagnostics = true;
  const stamp = () => new Date().toISOString();
  const utils = globalThis.ErrorUtils;
  if (utils && typeof utils.setGlobalHandler === 'function') {
    const previous = utils.getGlobalHandler && utils.getGlobalHandler();
    utils.setGlobalHandler((error, isFatal) => {
      console.error(
        `[rn-gpui] ${stamp()} ${isFatal ? 'fatal' : 'non-fatal'} JS error: ${
          (error && (error.stack || error.message)) || String(error)
        }`,
      );
      if (previous) previous(error, isFatal);
    });
  }
  try {
    const { AppState } = require('react-native');
    AppState.addEventListener('change', state =>
      console.log(`[rn-gpui] ${stamp()} app state -> ${state}`),
    );
  } catch (error) {
    console.warn(`[rn-gpui] app state logging unavailable: ${error}`);
  }
}
