import { codegenNativeComponent, type ViewProps } from 'react-native';

export interface NativeViewHostNativeProps extends ViewProps {
  viewName: string;
  nativePropsJson?: string;
}

export default codegenNativeComponent<NativeViewHostNativeProps>(
  'NativeViewHost',
);
