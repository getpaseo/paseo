/**
 * Holds the React Native children of a `NativeSlot`: the native tree paints the
 * node where the placeholder of the slot is, so it is positioned by the tree and
 * sized by the width the placeholder gives it.
 *
 * The name must end in `NativeComponent.ts`; see
 * `DesktopShortcutScopeNativeComponent.ts` for why.
 *
 * @format
 */

import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';

export interface NativeProps extends ViewProps {
  /** The native tree the slot belongs to. */
  rootId: CodegenTypes.Int32;
  /** The slot's id in that tree. */
  slotId: CodegenTypes.Int32;
}

export default codegenNativeComponent<NativeProps>('DesktopNativeSlot');
