// The package ships untranspiled Flow, which the unit project cannot parse. The sheet is a native
// presentation; tests that reach a menu do so through the popover, so rendering nothing is enough
// to keep the module graph importable.
const Stub = () => null;
const PassThrough = ({ children }: { children?: unknown }) => children;

export default Stub;
export const BottomSheetModal = Stub;
export const BottomSheetModalProvider = PassThrough;
export const BottomSheetBackdrop = Stub;
export const BottomSheetScrollView = PassThrough;
export const BottomSheetView = PassThrough;
export const BottomSheetTextInput = Stub;

// The app imports the internal layout values to compute the visible sheet body. Browser unit tests
// never render the native sheet, but Vite still validates this module's export surface.
const sharedValue = (value: unknown) => ({ get: () => value });

export const KEYBOARD_STATUS = { SHOWN: "SHOWN" };
export function useBottomSheetInternal() {
  return {
    animatedDetentsState: sharedValue({ detents: [] as number[] }),
    animatedKeyboardState: sharedValue({ heightWithinContainer: 0, status: "HIDDEN" }),
    animatedLayoutState: sharedValue({ containerHeight: 0, handleHeight: 0 }),
    animatedPosition: sharedValue(0),
  };
}
