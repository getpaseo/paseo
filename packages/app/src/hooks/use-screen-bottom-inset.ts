import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsLiveVoiceStripDocked } from "@/live-voice/live-voice-placement";

/**
 * The bottom safe-area inset for content docked at the app layout's bottom edge.
 *
 * Collapses to 0 while the Live Voice strip owns that edge: the strip pads for
 * the home indicator itself, so a screen that keeps its own padding doubles the
 * gap. The strip's presence is read synchronously from the same predicate the
 * strip renders on, so the inset never lags a frame behind it.
 *
 * Not for window-covering overlays — modals, sheets, and toasts render over the
 * strip rather than above it, so they keep `useSafeAreaInsets`. Compact panels
 * do use it: they cover the content row only, so the strip stays below them.
 */
export function useScreenBottomInset(): number {
  const insets = useSafeAreaInsets();
  const isLiveVoiceStripDocked = useIsLiveVoiceStripDocked();
  return isLiveVoiceStripDocked ? 0 : insets.bottom;
}
