// @gorhom/bottom-sheet 5.2.14's runtime (lib/module) exports the internal modal provider, but its
// shipped type declarations lag behind and omit it — upstream code (host-scope.tsx) imports it.
// Remove this augmentation when the package's types catch up.
import type { ComponentType, ReactNode } from "react";

declare module "@gorhom/bottom-sheet" {
  export const BottomSheetModalInternalProvider: ComponentType<{
    value: Record<string, unknown>;
    children?: ReactNode;
  }>;
}
