import * as React from "react";
import { Text, type TextProps } from "react-native";

interface UITextViewProps extends TextProps {
  // iOS-only prop on the real library; ignored here.
  uiTextView?: boolean;
}

// Web bundle must not import `react-native-uitextview`. The library transitively
// imports `react-native/Libraries/Utilities/codegenNativeComponent`, which pulls
// in `setUpReactDevTools` and breaks Metro web bundling in dev mode (the
// `ReactDevToolsSettingsManager` source path doesn't resolve in the web target).
//
// On web, react-native-web's Text already renders as a <div>/<span> with
// `user-select: text` enabled by default, so selectability is unchanged from
// using base Text.
export function UITextView({ uiTextView: _uiTextView, ...rest }: UITextViewProps) {
  return <Text {...rest} />;
}
