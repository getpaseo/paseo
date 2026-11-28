import type { DimensionValue } from "react-native";

/**
 * Where a provider sheet sits, decided by the surface that opens it. Setup passes its own card's
 * size so the sheet covers the card exactly and reads as a page of setup.
 */
export interface ProviderSheetFrame {
  desktopMaxWidth?: number;
  desktopHeight?: DimensionValue;
  snapPoints?: string[];
  /** A back arrow replaces the close button: the sheet stands in for a page of the surface below. */
  returns?: boolean;
}

export const OVERLAY_SHEET_FRAME: ProviderSheetFrame = { snapPoints: ["65%", "92%"] };
