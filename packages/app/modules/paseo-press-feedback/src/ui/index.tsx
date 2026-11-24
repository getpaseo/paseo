import { useCallback, useRef, type RefObject } from "react";
import { isNative } from "@/constants/platform";
import { usePanelStore } from "@/stores/panel-store";
import { acceptWorkspaceRowPress } from "../accept";
import { RowFeedback, type RowFeedbackHandle } from "./feedback";

export function useWorkspaceRowPress({
  didLongPressRef,
  onPress,
  selected,
}: {
  didLongPressRef?: RefObject<boolean>;
  onPress(): void;
  selected: boolean;
}) {
  const feedback = useRef<RowFeedbackHandle>(null);
  const handlePress = useCallback(() => {
    const cancelled = didLongPressRef?.current ?? false;
    if (didLongPressRef) didLongPressRef.current = false;
    const panel = usePanelStore.getState();
    acceptWorkspaceRowPress({
      cancelled,
      native: isNative,
      selected,
      sidebar: panel.layout.leftSidebar,
      target: panel.mobilePanel.target,
      // Paint on the native UI thread before navigation occupies JS; never wait for paint.
      acknowledge: () => {
        void feedback.current?.acknowledge();
      },
      navigate: onPress,
    });
  }, [didLongPressRef, onPress, selected]);
  return {
    onPress: handlePress,
    feedback: <RowFeedback ref={feedback} selected={selected} />,
  };
}
