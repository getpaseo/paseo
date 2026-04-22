import { ActivityIndicator, type ActivityIndicatorProps } from "react-native";

interface LoadingSpinnerProps {
  color: string;
  size?: ActivityIndicatorProps["size"];
}

export function LoadingSpinner({ color, size = "small" }: LoadingSpinnerProps) {
  return <ActivityIndicator size={size} color={color} />;
}
