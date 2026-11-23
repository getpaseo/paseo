/**
 * Deep import of React Native's `usePressability`.
 *
 * The hook only became a root `react-native` export around 0.84. The peer
 * dependency is `react-native: "*"`, so a named root import is `undefined`
 * before that.
 *
 * `Libraries/Pressability/usePressability.js` exists on those versions, so
 * we use that deep import instead.
 *
 * The export shape has changed across versions: newer ones use `export
 * default` (surfacing as `.default` after Metro's CJS transform) while older
 * ones assigned `module.exports` directly. A raw require bypasses Babel's
 * import interop, so both shapes are handled here.
 */
import type {
  PressabilityConfig,
  PressabilityEventHandlers,
} from 'react-native';

/**
 * Copied from the type for usePressability in
 * packages/react-native-enriched-markdown/node_modules/react-native/types_generated/Libraries/Pressability/usePressability.d.ts
 */
type UsePressability = (
  config: null | undefined | PressabilityConfig
) => null | PressabilityEventHandlers;

const usePressabilityModule =
  // eslint-disable-next-line @react-native/no-deep-imports
  require('react-native/Libraries/Pressability/usePressability');

export const usePressability = (usePressabilityModule.default ??
  usePressabilityModule) as UsePressability;
