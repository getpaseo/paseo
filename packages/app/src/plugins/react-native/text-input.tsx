import { forwardRef, type ElementRef } from "react";
import type { TextInputProps } from "react-native";

import type { SheetAwareTextInput } from "@/components/ui/text-input/sheet-aware";

export const TextInput = forwardRef<ElementRef<typeof SheetAwareTextInput>, TextInputProps>(
  function TextInput(props, ref) {
    const { SheetAwareTextInput } =
      require("../../components/ui/text-input/sheet-aware") as typeof import("../../components/ui/text-input/sheet-aware");
    return <SheetAwareTextInput {...props} ref={ref} />;
  },
);
