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
