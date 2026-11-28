/**
 * Puts React Native views inside a native tree.
 *
 * ```tsx
 * <NativeRoot>
 *   <Panel>
 *     <NativeSlot>
 *       <Text>Any React Native content</Text>
 *     </NativeSlot>
 *   </Panel>
 * </NativeRoot>
 * ```
 *
 * The children are rendered by the React Native tree the `NativeRoot` is in,
 * so they keep its contexts; the contexts of the native tree reach them too.
 * They are as wide as the tree's layout makes the slot and as high as their
 * content, and the tree paints, clips and hit-tests them where the slot is.
 *
 * @format
 */

import * as React from 'react';
import { useContextBridge } from 'its-fine';
import type { ViewStyle } from 'react-native';
import { SlotContext } from './slots';

export type NativeSlotProps = {
  children?: React.ReactNode;
  /** Style for the node that holds the children, such as `{ padding: 8 }`. */
  style?: ViewStyle;
  testID?: string;
  /**
   * Take the height the native layout gives the slot instead of the height of
   * the content: for a slot in a dialog, a tab or a panel that has a size of its
   * own, and for content that scrolls (a `ScrollView`, a list). Without it a
   * slot is as high as its content and the tree clips it where the layout
   * makes it shorter.
   */
  fill?: boolean;
  /**
   * Be as wide as the content instead of as wide as the native layout makes
   * the slot, so a native parent that centres or aligns its children can place
   * the content. The content is laid out against the width of the root.
   */
  fit?: boolean;
  /**
   * Clip the content to the slot's box. By default a slot clips unless it is
   * `fit`; `false` lets content drawn outside its box (a badge or a button
   * hanging over an edge) show, clipped only by the native parents.
   */
  clip?: boolean;
};

export function NativeSlot({
  children,
  style,
  testID,
  fill = false,
  fit = false,
  clip = !fit,
}: NativeSlotProps) {
  const api = React.useContext(SlotContext);
  if (api == null) {
    throw new Error('NativeSlot must be rendered inside a NativeRoot.');
  }
  const Bridge = useContextBridge();
  const [slotId] = React.useState(() => api.allocate());

  React.useLayoutEffect(() => {
    api.set(slotId, {
      children: <Bridge>{children}</Bridge>,
      style,
    });
  });

  React.useLayoutEffect(() => () => api.remove(slotId), [api, slotId]);

  return React.createElement('NativeSlot', {
    slotId,
    fill,
    fit,
    clip,
    testID,
  });
}
