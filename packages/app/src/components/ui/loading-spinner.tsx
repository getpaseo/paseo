import React from "react";
import { ActivityIndicator, type ActivityIndicatorProps } from "react-native";

interface LoadingSpinnerProps {
  color: string;
  size?: ActivityIndicatorProps["size"];
  style?: ActivityIndicatorProps["style"];
}

export function LoadingSpinner({ color, size = "small", style }: LoadingSpinnerProps) {
  return <ActivityIndicator size={size} color={color} style={style} />;
}
