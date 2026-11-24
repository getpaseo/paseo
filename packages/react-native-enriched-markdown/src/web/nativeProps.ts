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
type NativeOnlyPropName = Exclude<
  keyof NativeMarkdownTextProps,
  keyof WebMarkdownTextProps | keyof ViewProps
>;

export const NATIVE_ONLY_PROP_NAMES: Record<NativeOnlyPropName, true> = {
  onCopyPress: true,
  onLatexError: true,
  enableBlockContextMenu: true,
  enableLinkPreview: true,
  selectionHandleColor: true,
  allowFontScaling: true,
  maxFontSizeMultiplier: true,
  flavor: true,
  streamingAnimation: true,
  streamingConfig: true,
  spoilerOverlay: true,
  contextMenuItems: true,
  imageRequestHeaders: true,
  linkPillContent: true,
  linkContextMenuItems: true,
  selectionMenuConfig: true,
  accessibilityLabels: true,
  textBreakStrategy: true,
  lineBreakStrategyIOS: true,
  writingDirection: true,
  numberOfLines: true,
  ellipsizeMode: true,
};

const NATIVE_ONLY_PROPS = new Set<string>(Object.keys(NATIVE_ONLY_PROP_NAMES));

/**
 * Removes native-only props so they are never forwarded to a DOM element.
 * Returns a shallow copy; the input is left untouched.
 */
export function filterNativeOnlyProps<T extends object>(
  props: T
): Omit<T, NativeOnlyPropName> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!NATIVE_ONLY_PROPS.has(key)) {
      result[key] = value;
    }
  }
  return result as Omit<T, NativeOnlyPropName>;
}
