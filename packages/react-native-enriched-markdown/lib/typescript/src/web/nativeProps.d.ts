import type { ViewProps } from 'react-native';
import type { EnrichedMarkdownTextProps as NativeMarkdownTextProps } from '../types/MarkdownTextProps';
import type { EnrichedMarkdownTextProps as WebMarkdownTextProps } from '../types/MarkdownTextProps.web';
/**
 * Props that form the native (iOS/Android) EnrichedMarkdownText API but have no
 * effect on web.
 *
 * In a typical React Native + react-native-web project the component is
 * type-checked against the native `MarkdownTextProps.ts` interface (bundlers
 * swap in `.web.tsx` at runtime, but `tsc` resolves the base `.ts` unless the
 * project sets `moduleSuffixes`). So JSX like `flavor="github"` or
 * `streamingAnimation` compiles fine and would otherwise be spread onto the
 * root DOM element, triggering React "unknown prop" warnings. They are dropped
 * here before reaching the DOM.
 *
 * The set below is not hand-maintained: `NativeOnlyPropName` is derived as the
 * native prop names minus the ones web implements, so adding a native-only prop
 * to `MarkdownTextProps.ts` fails the build here until it is listed and thus
 * filtered. Generic React Native ViewProps (nativeID, accessibility*, hitSlop,
 * etc.) are excluded from that union and stay out of scope; they are documented
 * as not stripped in docs/WEB.md.
 *
 * The `react-native` and native-props imports are type-only, so nothing from
 * either reaches the web bundle.
 */
type NativeOnlyPropName = Exclude<keyof NativeMarkdownTextProps, keyof WebMarkdownTextProps | keyof ViewProps>;
export declare const NATIVE_ONLY_PROP_NAMES: Record<NativeOnlyPropName, true>;
/**
 * Removes native-only props so they are never forwarded to a DOM element.
 * Returns a shallow copy; the input is left untouched.
 */
export declare function filterNativeOnlyProps<T extends object>(props: T): Omit<T, NativeOnlyPropName>;
export {};
//# sourceMappingURL=nativeProps.d.ts.map