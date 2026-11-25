import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
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

/**
 * What a child that drags inside a scroll view needs to keep the touch: `setActive(true)` stops
 * the scroll until the drag ends, so the scroll view cannot take the finger once the drag has
 * armed. Inside a sheet the child also registers its drag gesture through `attach` so the sheet's
 * pan waits for it; outside a sheet there is no `attach`. Outside any scroll view that hosts
 * content drags, `setActive` does nothing.
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

interface ContentDragScrollProps {
  scrollEnabled?: boolean;
  children?: ReactNode;
}

/**
 * Makes a scroll view outside a sheet host content drags: it stops scrolling while a child drag
 * is active. Without it, a vertical drag in a row of a scrolling page is taken by the page scroll
 * once the finger moves past the touch slop, before the row's drag gesture can activate.
 */
export function withContentDrag<P extends ContentDragScrollProps, T>(
  Scroll: ComponentType<P & { ref?: Ref<T> }>,
) {
  return forwardRef<T, P>(function ContentDragScrollView(props, ref) {
    const [dragging, setDragging] = useState(false);
    const contentDrag = useMemo<ContentDrag>(
      () => ({ attach: undefined, setActive: setDragging }),
      [],
    );
    // Overriding two props of `P` keeps it a `P`; TypeScript cannot prove that for a generic.
    const scrollProps = {
      ...props,
      scrollEnabled: !dragging && props.scrollEnabled !== false,
      children: (
        <ContentDragContext.Provider value={contentDrag}>
          {props.children}
        </ContentDragContext.Provider>
      ),
    } as P;
    return <Scroll {...scrollProps} ref={ref} />;
  });
}

const PageScrollView = withContentDrag<ScrollViewProps, NativeScrollView>(NativeScrollView);

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
