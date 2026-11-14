import { createContext } from "react";
import type { LayoutRectangle } from "react-native";

export const AppWindowFrameContext = createContext<LayoutRectangle | null>(null);
