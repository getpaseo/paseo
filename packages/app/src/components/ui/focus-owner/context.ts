import { createContext, useContext, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/**
 * Called when a press or a focus move lands in what the owner owns. Must be stable, and safe to
 * call repeatedly.
 */
export type FocusOwner = () => void;

export const FocusOwnerContext = createContext<FocusOwner | null>(null);

/** The focus owner of the React position it is read at, or `null` outside every owner. */
export function useFocusOwner(): FocusOwner | null {
  return useContext(FocusOwnerContext);
}

export interface FocusOwnerScopeProps {
  /** `null` renders the children as they are, with no extra node. */
  owner: FocusOwner | null;
  /**
   * Native only: the box the scope draws to listen for touches. Web draws no box
   * (`display: contents`), so the children lay out as if the scope were not there.
   */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}
