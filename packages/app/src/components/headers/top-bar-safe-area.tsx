import { useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TopBarSafeAreaFrame, type TopBarSafeAreaProps } from "./top-bar-safe-area.shared";

export type { TopBarSafeAreaProps } from "./top-bar-safe-area.shared";

export function TopBarSafeArea(props: TopBarSafeAreaProps) {
  const insets = useSafeAreaInsets();
  const geometry = useMemo(() => ({ top: insets.top, left: 0, right: 0 }), [insets.top]);
  // The app shell already owns horizontal safe-area padding on these platforms.
  return <TopBarSafeAreaFrame {...props} geometry={geometry} />;
}
