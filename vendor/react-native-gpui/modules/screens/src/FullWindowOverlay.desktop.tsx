import React, { type PropsWithChildren } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import FullWindowOverlayNativeComponent from 'react-native-screens/src/fabric/FullWindowOverlayNativeComponent';
import type { NativeProps } from 'react-native-screens/src/fabric/FullWindowOverlayNativeComponent';

export default function FullWindowOverlay({
  children,
  ...props
}: PropsWithChildren<NativeProps>) {
  const { width, height } = useWindowDimensions();
  return (
    <FullWindowOverlayNativeComponent
      {...props}
      style={[StyleSheet.absoluteFill, { width, height }, props.style]}
    >
      {children}
    </FullWindowOverlayNativeComponent>
  );
}
