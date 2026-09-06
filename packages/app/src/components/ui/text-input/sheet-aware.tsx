import { forwardRef, useCallback } from "react";
import { TextInput as NativeTextInput, type TextInputProps } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { isNative } from "@/constants/platform";
import { useIsInsideBottomSheet } from "../bottom-sheet-scope";

/** Registers focus with the sheet so the keyboard can move the active input into view. */
export const SheetAwareTextInput = forwardRef<NativeTextInput, TextInputProps>(
  function SheetAwareTextInput(props, ref) {
    const inSheet = useIsInsideBottomSheet();
    const setRef = useCallback(
      (input: NativeTextInput | null | undefined) => {
        if (typeof ref === "function") ref(input ?? null);
        else if (ref) ref.current = input ?? null;
      },
      [ref],
    );
    return inSheet && isNative ? (
      <BottomSheetTextInput {...props} ref={setRef} />
    ) : (
      <NativeTextInput {...props} ref={setRef} />
    );
  },
);
