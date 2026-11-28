import { Text as NativeText } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

// Web numeric tokens are baked into classes. Subscribe this leaf so withUnistyles
// resolves its style prop again without replacing the surrounding form or scroll view.
function typographyChanges(theme: Theme) {
  void theme.fontSize;
  return {};
}

export const AppearanceText = withUnistyles(NativeText, typographyChanges);
