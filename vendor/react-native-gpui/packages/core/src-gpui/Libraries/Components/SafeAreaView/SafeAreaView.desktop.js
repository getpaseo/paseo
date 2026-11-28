/**
 * A window drawn under a transparent title bar has content behind the bar, so
 * the view pads its top by the bar's height. Every other window has no inset.
 */
import * as React from 'react';
import View from '../View/View';
import StyleSheet from '../../StyleSheet/StyleSheet';
import { useDesktopWindowId } from '@react-native-gpui/core/desktop';
import { useWindowStateSelector } from '@react-native-gpui/core/src-gpui/src/private/desktop/windows';

const SafeAreaView = React.forwardRef(function SafeAreaView(props, ref) {
  const inset = useWindowStateSelector(
    useDesktopWindowId(),
    state => state?.topInset ?? 0,
  );
  if (inset === 0) {
    return <View {...props} ref={ref} />;
  }
  const flat = StyleSheet.flatten(props.style) ?? {};
  const own = flat.paddingTop ?? flat.paddingVertical ?? flat.padding ?? 0;
  return (
    <View
      {...props}
      ref={ref}
      style={[
        props.style,
        { paddingTop: (typeof own === 'number' ? own : 0) + inset },
      ]}
    />
  );
});

SafeAreaView.displayName = 'SafeAreaView';
export default SafeAreaView;
