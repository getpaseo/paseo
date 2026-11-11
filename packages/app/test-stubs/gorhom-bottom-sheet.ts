// The package ships untranspiled Flow, which the unit project cannot parse. The sheet is a native
// presentation; tests that reach a menu do so through the popover, so rendering nothing is enough
// to keep the module graph importable.
const Stub = () => null;
const PassThrough = ({ children }: { children?: unknown }) => children;
const sharedValue = (value: unknown) => ({ get: () => value });

export default Stub;
export const BottomSheetModal = Stub;
export const BottomSheetModalProvider = PassThrough;
export const BottomSheetBackdrop = Stub;
export const BottomSheetHandle = Stub;
export const BottomSheetScrollView = PassThrough;
export const BottomSheetView = PassThrough;
export const BottomSheetTextInput = Stub;

export function useBottomSheetModal(): never {
  throw new Error("Modal stack interactions require the real Gorhom provider in browser E2E tests");
}

// A sheet host scope only redirects where sheets draw; with no sheet drawn there is nothing to host.
export function useBottomSheet(): never {
  throw new Error("useBottomSheet is unavailable in tests");
}
export const BottomSheetModalInternalProvider = PassThrough;
export const INITIAL_CONTAINER_LAYOUT = {
  height: 0,
  offset: { top: 0, bottom: 0, left: 0, right: 0 },
};
export function useBottomSheetModalInternal() {
  return {
    hostName: "stub",
    containerLayoutState: sharedValue(INITIAL_CONTAINER_LAYOUT),
    mountSheet: () => undefined,
    unmountSheet: () => undefined,
    willUnmountSheet: () => undefined,
  };
}

// The app imports the internal layout values to compute the visible sheet body. Browser unit tests
// never render the native sheet, but Vite still validates this module's export surface.
export const KEYBOARD_STATUS = { SHOWN: "SHOWN" };
export function useBottomSheetInternal() {
  return {
    animatedDetentsState: sharedValue({ detents: [] as number[] }),
    animatedKeyboardState: sharedValue({ heightWithinContainer: 0, status: "HIDDEN" }),
    animatedLayoutState: sharedValue({ containerHeight: 0, handleHeight: 0 }),
    animatedPosition: sharedValue(0),
  };
}
