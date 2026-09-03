import { PointerType } from "react-native-gesture-handler";

// Called from the tap gesture's `onTouchesDown`, which runs on the UI thread: without the
// directive the UI runtime holds a serialized object rather than a callable worklet, and the
// first touch on any highlighted row takes the whole process down with "Object is not a
// function".
export function shouldTrackNativePressHighlight(pointerType: PointerType): boolean {
  "worklet";
  return pointerType !== PointerType.MOUSE;
}
