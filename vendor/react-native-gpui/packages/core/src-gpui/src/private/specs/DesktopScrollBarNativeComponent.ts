/**
 * Customizes the scrollbar of the nearest `ScrollView`, including one inside a
 * `FlatList` or `SectionList`: put it among the scroll view's children, or in a
 * list's header or footer.
 *
 * The component paints and lays out nothing. The scroll view that contains it
 * reads these props and draws its own bar, so `style` has no effect.
 *
 * The name must end in `NativeComponent.ts`: React Native's babel plugin turns
 * any such file into a static view config, which is how core's other
 * hand-registered host components (`DesktopShortcutScope`) work too. Core has
 * no component codegen, so the props and the descriptor are hand-written; see
 * `ReactCxxPlatform/react/renderer/components/desktopscrollbar/`.
 *
 * @format
 */

import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';
import type { ColorValue } from 'react-native';

/** What a drag event carries. */
export type ScrollBarEvent = Readonly<{
  /** The scroll view's offset when the event fired. */
  contentOffset: Readonly<{ x: CodegenTypes.Double; y: CodegenTypes.Double }>;
}>;

// @ts-expect-error onDragStart, onDrag and onDragEnd are the scroll bar's own events, not View's drag events
export interface NativeProps extends ViewProps {
  /** Width of a vertical bar, height of a horizontal one. Defaults to 6. */
  thickness?: CodegenTypes.Float;
  /** The shortest the thumb gets, however long the content. Defaults to 24. */
  minLength?: CodegenTypes.Float;
  /** Space between the bar and the scroll view's edge, and at each end. Defaults to 2. */
  margin?: CodegenTypes.Float;
  /** The thumb's color; an alpha channel makes it translucent. */
  color?: ColorValue;
  /** The thumb's corner radius. Defaults to half the thickness. */
  radius?: CodegenTypes.Float;
  /** The color of the strip behind the thumb. No track is drawn when unset. */
  trackColor?: ColorValue;
  /**
   * `'auto'` shows the bar while scrolling and at the edge, `'always'` whenever
   * the content scrolls, `'hover'` only at the edge.
   */
  visibility?: string;
  /** How long, in milliseconds, the bar stays after the last scroll. Defaults to 1200. */
  autoHideDelay?: CodegenTypes.Float;
  /** Whether the thumb can be dragged and revealed by the pointer. Defaults to true. */
  interactive?: boolean;
  onDragStart?: CodegenTypes.DirectEventHandler<
    ScrollBarEvent,
    'topScrollBarThumbDragStart'
  >;
  onDrag?: CodegenTypes.DirectEventHandler<
    ScrollBarEvent,
    'topScrollBarThumbDrag'
  >;
  onDragEnd?: CodegenTypes.DirectEventHandler<
    ScrollBarEvent,
    'topScrollBarThumbDragEnd'
  >;
}

export default codegenNativeComponent<NativeProps>('DesktopScrollBar');
