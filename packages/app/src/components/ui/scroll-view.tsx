import { createContext, forwardRef, useContext, useMemo, useState, type Ref } from "react";
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
import {
  useAttachSheetContentDrag,
  useIsInsideBottomSheet,
  type AttachSheetContentDrag,
} from "./bottom-sheet-scope";

// Both libraries forward to the RN FlatList instance. Their published ref types
// disagree about getScrollResponder (Gorhom) and include the component function
// in the instance intersection (RNGH); keep that type discrepancy at this boundary.
const SheetFlatList = BottomSheetFlatList as unknown as typeof NativeFlatList;
const HorizontalFlatList = GestureFlatList as unknown as <Item>(
  props: FlatListProps<Item> & NativeViewGestureHandlerProps & { ref?: Ref<NativeFlatList<Item>> },
) => React.ReactElement;

/** The presentation owns gesture integration; callers keep the React Native API. */
export const ScrollView = forwardRef<NativeScrollView, ScrollViewProps>(
  function ScrollView(props, ref) {
    const inSheet = useIsInsideBottomSheet();
    if (!inSheet) return <NativeScrollView {...props} ref={ref} />;
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

/**
 * What a child that drags inside a sheet needs to keep the touch: it registers its drag gesture
 * through `attach` so the sheet's pan waits for it, and `setActive(true)` stops the sheet's
 * scroll until the drag ends. Outside a sheet scroll there is no `attach` and `setActive` does
 * nothing.
 */
export interface ContentDrag {
  attach: AttachSheetContentDrag | undefined;
  setActive: (active: boolean) => void;
}

const ContentDragContext = createContext<ContentDrag | null>(null);

const NO_CONTENT_DRAG: ContentDrag = { attach: undefined, setActive: () => {} };

export function useContentDrag(): ContentDrag {
  return useContext(ContentDragContext) ?? NO_CONTENT_DRAG;
}

const SheetScrollView = forwardRef<NativeScrollView, ScrollViewProps>(
  function SheetScrollView(props, ref) {
    const attach = useAttachSheetContentDrag();
    const [dragging, setDragging] = useState(false);
    const contentDrag = useMemo(() => ({ attach, setActive: setDragging }), [attach]);
    return (
      <BottomSheetScrollView
        {...props}
        scrollEnabled={!dragging && props.scrollEnabled !== false}
        ref={ref}
      >
        <ContentDragContext.Provider value={contentDrag}>
          {props.children}
        </ContentDragContext.Provider>
      </BottomSheetScrollView>
    );
  },
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
