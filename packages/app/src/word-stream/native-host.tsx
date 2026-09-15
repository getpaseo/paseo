import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import type { FadeRange } from "./internal/reveal";

interface WordFadeHostProps extends ViewProps {
  ranges: readonly FadeRange[];
  children: ReactNode;
}

export const WordFadeHost = requireNativeViewManager<WordFadeHostProps>("PaseoWordStream");
