import { BottomSheetBackdrop, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";

/**
 * What a backdrop tap does. `dismiss` takes the top modal off the stack and unmounts it; `close`
 * only slides this sheet down, so a sheet that keeps its content through a close can veto it.
 */
export type SheetBackdropPress = "dismiss" | "close";

export function SheetBackdrop({
  pressBehavior: _pressBehavior,
  ...props
}: BottomSheetBackdropProps & { opacity?: number; pressBehavior: SheetBackdropPress }) {
  // Gorhom's native backdrop closes its own sheet, which here is always the top one.
  return <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />;
}
