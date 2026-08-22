// Reanimated's native code path imports `react-native/Libraries/Renderer/shims/ReactFabric`.
// The `react-native` alias below points at a react-native-web file, so the subpath cannot
// resolve; on web reanimated takes `findHostInstance.web.js` and never reaches this.
export function findHostInstance_DEPRECATED(): null {
  return null;
}

export default { findHostInstance_DEPRECATED };
