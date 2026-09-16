import { View, type ViewProps } from "react-native";

interface ComposerViewportProps extends ViewProps {
  bottomInset?: number;
  centered?: boolean;
}

export function ComposerViewport({
  bottomInset: _bottomInset,
  centered: _centered,
  ...props
}: ComposerViewportProps) {
  return <View {...props} />;
}

export function ComposerViewportContent(props: ViewProps) {
  return <View {...props} />;
}
