import { forwardRef, type Ref } from "react";
import {
  ScrollView as NativeScrollView,
  FlatList as NativeFlatList,
  type ScrollViewProps,
  type FlatListProps,
} from "react-native";
import { BottomSheetScrollView, BottomSheetFlatList } from "@gorhom/bottom-sheet";
import {
  ScrollView as GestureScrollView,
  FlatList as GestureFlatList,
  type NativeViewGestureHandlerProps,
} from "react-native-gesture-handler";
import { isNative } from "@/constants/platform";
import { useAttachSheetContentDrag, useIsInsideBottomSheet } from "./bottom-sheet-scope";
import { withContentDrag } from "./content-drag";

// Both libraries forward to the RN FlatList and ScrollView instances. Their published ref types
// disagree about getScrollResponder (Gorhom) and include the component function
// in the instance intersection (RNGH); keep that type discrepancy at this boundary.
const SheetScroll = BottomSheetScrollView as unknown as typeof NativeScrollView;
const SheetFlatList = BottomSheetFlatList as unknown as typeof NativeFlatList;
const HorizontalFlatList = GestureFlatList as unknown as <Item>(
  props: FlatListProps<Item> & NativeViewGestureHandlerProps & { ref?: Ref<NativeFlatList<Item>> },
) => React.ReactElement;

/** The presentation owns gesture integration; callers keep the React Native API. */
export const ScrollView = forwardRef<NativeScrollView, ScrollViewProps>(
  function ScrollView(props, ref) {
    const inSheet = useIsInsideBottomSheet();
    if (!inSheet) return <PageScrollView {...props} ref={ref} />;
    if (props.horizontal) {
      return isNative ? (
        <GestureScrollView {...props} ref={ref} disallowInterruption />
      ) : (
        <NativeScrollView {...props} ref={ref} />
      );
    }
    return <SheetScrollView {...props} ref={ref} />;
  },
);

const PageScrollView = withContentDrag<ScrollViewProps, NativeScrollView>(NativeScrollView);

const SheetScrollView = withContentDrag<ScrollViewProps, NativeScrollView>(
  SheetScroll,
  useAttachSheetContentDrag,
);

function SheetAwareFlatList<Item>(props: FlatListProps<Item>, ref: Ref<NativeFlatList<Item>>) {
  const inSheet = useIsInsideBottomSheet();
  if (!inSheet) return <NativeFlatList {...props} ref={ref} />;
  if (props.horizontal) {
    return isNative ? (
      <HorizontalFlatList {...props} ref={ref} disallowInterruption />
    ) : (
      <NativeFlatList {...props} ref={ref} />
    );
  }
  return <SheetFlatList {...props} ref={ref} />;
}

// forwardRef erases the item generic. All three implementations expose the RN list methods.
export const FlatList = forwardRef(SheetAwareFlatList) as <Item>(
  props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
) => React.ReactElement;
