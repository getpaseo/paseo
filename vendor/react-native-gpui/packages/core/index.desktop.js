// Keep the GPUI entry aligned with React Native's public JavaScript surface.
//
// The desktop-shell wrapper component is installed here: the host
// passes each window's surface `windowId` as `initialProps`, and the wrapper
// turns it into the `DesktopWindowContext` that `DesktopWindow.current()` reads.
// Doing it on the platform entry guarantees it happens before the app's own
// `AppRegistry.registerComponent` runs.
const {
  installDesktopWindowContext,
} = require('./src-gpui/src/private/desktop/windowContext');

installDesktopWindowContext();

module.exports = require('react-native');
