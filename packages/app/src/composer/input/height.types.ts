import type { TextStyle } from "react-native";

export type ComposerHeightResult =
  | {
      mode: "intrinsic";
      style: TextStyle;
      scrollEnabled: true;
    }
  | {
      mode: "measured";
      style: TextStyle;
      scrollEnabled: boolean;
      onTextChange: (previousText: string, nextText: string) => void;
      reset: () => void;
    };
