import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type Ref,
} from "react";
import type { AttachSheetContentDrag } from "./bottom-sheet-scope";

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

function useNoAttach(): AttachSheetContentDrag | undefined {
  return undefined;
}

/**
 * Makes a scroll view host content drags: it stops scrolling while a child drag is active. Without
 * it, a vertical drag in a row of a scrolling page is taken by the page scroll once the finger
 * moves past the touch slop, before the row's drag gesture can activate. A sheet's scroll view
 * passes `useAttach` so its children can also register their gesture with the sheet.
 *
 * The context wraps the scroll view rather than its content, so the scroll view receives its
 * children as given: `stickyHeaderIndices` counts them.
 */
export function withContentDrag<P extends { scrollEnabled?: boolean }, T>(
  Scroll: ComponentType<P & { ref?: Ref<T> }>,
  useAttach: () => AttachSheetContentDrag | undefined = useNoAttach,
) {
  return forwardRef<T, P>(function ContentDragScrollView(props, ref) {
    const attach = useAttach();
    const [dragging, setDragging] = useState(false);
    const contentDrag = useMemo(() => ({ attach, setActive: setDragging }), [attach]);
    // Overriding one prop of `P` keeps it a `P`; TypeScript cannot prove that for a generic.
    const scrollProps = {
      ...props,
      scrollEnabled: !dragging && props.scrollEnabled !== false,
    } as P;
    return (
      <ContentDragContext.Provider value={contentDrag}>
        <Scroll {...scrollProps} ref={ref} />
      </ContentDragContext.Provider>
    );
  });
}
