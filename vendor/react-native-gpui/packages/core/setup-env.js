// RN 0.87's development setup expects the browser `window` global. A JS engine
// on the desktop only has `globalThis`, so provide the alias before the stock
// RN setup.
// This file is loaded by the CLI before the app entry module.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

module.exports = require('react-native/setup-env');
