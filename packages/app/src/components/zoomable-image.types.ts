export interface ZoomableImageProps {
  uri: string;
  accessibilityLabel: string;
  onError: () => void;
  onLongPress?: () => void;
  testID?: string;
}
