import { View, type ViewProps } from "react-native";

interface ComposerViewportProps extends ViewProps {
  bottomInset?: number;
  centered?: boolean;
  keyboardReserve?: "retain" | "release";
}

export function ComposerViewport({
  bottomInset: _bottomInset,
  centered: _centered,
  keyboardReserve: _keyboardReserve,
  ...props
}: ComposerViewportProps) {
  return <View {...props} />;
}

export function ComposerViewportContent(props: ViewProps) {
  return <View {...props} />;
}
