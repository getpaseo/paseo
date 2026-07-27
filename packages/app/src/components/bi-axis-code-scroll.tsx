import type { ReactNode } from "react";
import { ScrollView as RNScrollView, type StyleProp, type ViewStyle } from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { isWeb } from "@/constants/platform";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

export interface BiAxisCodeScrollProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Nested vertical→horizontal ScrollViews put the horizontal indicator at the
 * bottom of the *content*, not the card. Native keeps that nesting; web uses
 * {@link ./bi-axis-code-scroll.web.tsx} so both bars sit on the viewport edges.
 */
export function BiAxisCodeScroll({
  children,
  style,
  contentContainerStyle,
  testID,
}: BiAxisCodeScrollProps) {
  return (
    <ScrollView style={style} nestedScrollEnabled showsVerticalScrollIndicator testID={testID}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        contentContainerStyle={contentContainerStyle}
      >
        {children}
      </ScrollView>
    </ScrollView>
  );
}
