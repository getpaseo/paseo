import React from 'react';
import type { ViewProps } from 'react-native';

import NativeViewHostNativeComponent from './NativeViewHostNativeComponent';

export type NativeViewHostProps = ViewProps & {
  viewName: string;
  nativeProps?: Record<string, unknown>;
};

export default function NativeViewHost({
  viewName,
  nativeProps,
  ...props
}: NativeViewHostProps): React.JSX.Element {
  return (
    <NativeViewHostNativeComponent
      {...props}
      viewName={viewName}
      nativePropsJson={JSON.stringify(nativeProps ?? {})}
    />
  );
}
