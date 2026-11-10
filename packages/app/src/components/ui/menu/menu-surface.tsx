import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { ChevronLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
  type ContextBridge,
} from "@/components/ui/isolated-bottom-sheet-modal";
import {
  FULL_SHEET_SNAP_POINTS,
  SheetBackground,
  SheetHandle,
} from "@/components/adaptive-modal-sheet";
import { SPACING, type Theme } from "@/styles/theme";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useMenuContext, MenuContextProvider } from "./menu-context";
import { MenuPage } from "./menu-item";
import { currentPageId, isSubPageOpen } from "./menu-navigation";
import { AnchoredSurface, MenuOverlay } from "./menu-overlay";
import { getMenuSheetBottomPadding } from "./menu-sheet-layout";
import type { Alignment, Placement } from "../anchor";
import type { KeyboardFocusScope } from "@/keyboard/actions";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** How long the pointer must rest on a submenu row before its flyout opens. */
const HOVER_OPEN_DELAY_MS = 90;
/**
 * How long a flyout survives after the pointer leaves. The pointer still crosses sibling rows on
 * its way down into the flyout, so leaving the trigger cannot close it immediately.
 */
const HOVER_CLOSE_GRACE_MS = 260;
/**
 * How far the flyout sits *over* its parent surface rather than beside it. The overlap is what
 * makes the hand-off reliable: with a gap there is a strip of backdrop between the two where the
 * pointer belongs to neither, and every pixel of it is a chance to dismiss the thing you are
 * reaching for. Overlapping removes the strip instead of timing around it.
 */
const SUBMENU_OVERLAP = 5;

export interface MenuListPageDefinition {
  id: string;
  title: string;
  content: ReactNode;
  /**
   * Whether the pointer opens and closes this page on its own. Default true.
   *
   * A page that takes typed input sets this false: hover intent would open it on a pointer that
   * was only passing through, and then dismiss it — draft and all — the moment the hands moved
   * to the keyboard and the mouse drifted off the flyout. While such a page is open, the whole
   * surface stops closing on hover, since its parent leads back to the same dismissal.
   */
  hoverIntent?: boolean;
  fill?: false;
}

/**
 * A sheet page that takes the sheet's full height and draws everything itself, header included:
 * no back header, no scroller, no content panning. Only the sheet presentation opens one; a
 * popover never has a trigger for it.
 */
export interface MenuFillPageDefinition {
  id: string;
  fill: true;
  content: ReactNode;
}

export type MenuPageDefinition = MenuListPageDefinition | MenuFillPageDefinition;

function pageHoverIntent(page: MenuPageDefinition | undefined): boolean {
  return !page || page.fill === true || page.hoverIntent !== false;
}

interface MenuSurfaceContextValue {
  registerSubAnchor: (id: string, ref: React.RefObject<View | null>) => void;
  hoverOpen: (sub: { id: string; depth: number }) => void;
  hoverClose: (depth: number) => void;
  cancelHoverClose: () => void;
}

const MenuSurfaceContext = createContext<MenuSurfaceContextValue | null>(null);

export function useMenuSurface(componentName: string): MenuSurfaceContextValue {
  const ctx = useContext(MenuSurfaceContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <MenuSurface />`);
  }
  return ctx;
}

export interface MenuSurfaceProps {
  /** Root page content. */
  children: ReactNode;
  /** Sub pages, reachable from a `MenuSubTrigger` on the root page. */
  pages?: readonly MenuPageDefinition[];
  /** Title shown on the sheet's root page. Sheets always have a header; popovers never do. */
  sheetTitle?: string;
  /** Controls on the right of the sheet's root title. */
  sheetTrailing?: ReactNode;
  side?: Placement;
  align?: Alignment;
  offset?: number;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  fullWidth?: boolean;
  horizontalPadding?: number;
  scrollable?: boolean;
  testID?: string;
  /** Limits ordinary app shortcuts to the time this menu owns keyboard focus. */
  keyboardFocusScope?: KeyboardFocusScope;
}

/**
 * The open menu. Reads its presentation from the menu root and renders either an anchored
 * popover (plus one flyout per open submenu) or a bottom sheet showing one page at a time.
 */
export function MenuSurface(props: MenuSurfaceProps): ReactElement | null {
  const { presentation, open, setOpen, path, prunePages } = useMenuContext("MenuSurface");
  const active = useRetainedPanelActive();
  // An open page whose definition went away (its row was removed) falls back to its parent, so
  // neither a render nor a later Back walks a path to a page that no longer exists.
  const { pages } = props;
  useEffect(() => {
    if (path.length === 0) return;
    prunePages((id) => pages?.some((page) => page.id === id) ?? false);
  }, [pages, path, prunePages]);
  // A menu belongs to the panel that opened it. When that panel leaves the screen the menu closes
  // for good, rather than waiting hidden to reappear with the panel: a row that opened a sheet
  // and promoted it to a tab, say, would otherwise bring the list back on the next tab switch.
  useEffect(() => {
    if (!active && open) setOpen(false);
  }, [active, open, setOpen]);
  // Portals escape the hidden panel. Remove the surface in its inactive commit,
  // before freezing can suspend an async menu action's closing update.
  if (!active) return null;
  if (presentation === "sheet") {
    return <MenuSheetSurface {...props} />;
  }
  return <MenuPopoverSurface {...props} />;
}

function useSubAnchors(): {
  value: MenuSurfaceContextValue;
  getAnchor: (id: string) => React.RefObject<View | null> | null;
} {
  const anchors = useRef(new Map<string, React.RefObject<View | null>>());
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { openSub, closeSub } = useMenuContext("MenuSurface");

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const registerSubAnchor = useCallback((id: string, ref: React.RefObject<View | null>) => {
    anchors.current.set(id, ref);
  }, []);

  const hoverOpen = useCallback(
    (sub: { id: string; depth: number }) => {
      clearTimers();
      openTimer.current = setTimeout(() => openSub(sub), HOVER_OPEN_DELAY_MS);
    },
    [clearTimers, openSub],
  );

  const hoverClose = useCallback(
    (depth: number) => {
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = null;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => closeSub(depth), HOVER_CLOSE_GRACE_MS);
    },
    [closeSub],
  );

  const cancelHoverClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const value = useMemo(
    () => ({ registerSubAnchor, hoverOpen, hoverClose, cancelHoverClose }),
    [registerSubAnchor, hoverOpen, hoverClose, cancelHoverClose],
  );

  const getAnchor = useCallback((id: string) => anchors.current.get(id) ?? null, []);

  return { value, getAnchor };
}

function MenuPopoverSurface({
  children,
  pages = [],
  side = "bottom",
  align = "start",
  offset = 4,
  width,
  minWidth = 180,
  maxWidth,
  maxHeight,
  fullWidth = false,
  horizontalPadding = 16,
  scrollable = false,
  testID,
  keyboardFocusScope,
}: MenuSurfaceProps): ReactElement | null {
  const menu = useMenuContext("MenuSurface");
  const { value: surfaceValue, getAnchor } = useSubAnchors();

  const handleClose = useCallback(() => menu.setOpen(false), [menu]);

  // Every open page in the path gets its own flyout, so a submenu of a submenu simply stacks.
  const openPages = useMemo(
    () =>
      menu.path
        .map((id, depth) => {
          const page = pages.find((candidate) => candidate.id === id);
          return page ? { page, depth } : null;
        })
        .filter((entry): entry is { page: MenuPageDefinition; depth: number } => entry !== null),
    [menu.path, pages],
  );

  // `hoverIntent: false` takes a page off the pointer entirely — it is not opened by resting on
  // its trigger, and while it is open nothing on this surface closes on a pointer leaving it.
  const hoverValue = useMemo<MenuSurfaceContextValue>(() => {
    const locked = openPages.some(({ page }) => !pageHoverIntent(page));
    return {
      ...surfaceValue,
      hoverOpen: (sub) => {
        if (!pageHoverIntent(pages.find((page) => page.id === sub.id))) return;
        surfaceValue.hoverOpen(sub);
      },
      hoverClose: (depth) => {
        if (locked) return;
        surfaceValue.hoverClose(depth);
      },
    };
  }, [openPages, pages, surfaceValue]);

  return (
    <MenuSurfaceContext.Provider value={hoverValue}>
      <MenuOverlay visible={menu.open} onClose={handleClose} restoreFocusRef={menu.triggerRef}>
        <>
          <AnchoredSurface
            open={menu.open}
            onClose={handleClose}
            anchorRect={menu.anchorRect}
            anchorRef={menu.triggerRef}
            side={side}
            align={align}
            offset={offset}
            width={width}
            minWidth={minWidth}
            maxWidth={maxWidth}
            maxHeight={maxHeight}
            fullWidth={fullWidth}
            horizontalPadding={horizontalPadding}
            scrollable={scrollable}
            testID={testID}
            keyboardFocusScope={keyboardFocusScope}
          >
            <MenuPage depth={0}>{children}</MenuPage>
          </AnchoredSurface>
          {openPages.map(({ page, depth }) => (
            <MenuFlyout
              key={page.id}
              page={page}
              depth={depth}
              anchorRef={getAnchor(page.id)}
              minWidth={minWidth}
              maxHeight={maxHeight}
              scrollable={scrollable}
              testID={testID ? `${testID}-${page.id}` : undefined}
            />
          ))}
        </>
      </MenuOverlay>
    </MenuSurfaceContext.Provider>
  );
}

/**
 * A submenu's own floating surface. It keeps itself alive while the pointer is inside it —
 * without that, walking from the row into the flyout would cross the gap between them and
 * trigger the close it was travelling to avoid.
 */
function MenuFlyout({
  page,
  depth,
  anchorRef,
  minWidth,
  maxHeight,
  scrollable,
  testID,
}: {
  page: MenuPageDefinition;
  depth: number;
  anchorRef: React.RefObject<View | null> | null;
  minWidth?: number;
  maxHeight?: number;
  scrollable?: boolean;
  testID?: string;
}): ReactElement | null {
  const menu = useMenuContext("MenuFlyout");
  const { hoverClose, cancelHoverClose } = useMenuSurface("MenuFlyout");
  const handleClose = useCallback(() => menu.setOpen(false), [menu]);
  const handleHoverOut = useCallback(() => hoverClose(depth), [hoverClose, depth]);

  if (!anchorRef) return null;

  return (
    <AnchoredSurface
      open
      onClose={handleClose}
      anchorRect={null}
      anchorRef={anchorRef}
      side="right"
      align="start"
      offset={-SUBMENU_OVERLAP}
      minWidth={minWidth}
      maxHeight={maxHeight}
      scrollable={scrollable}
      backdrop={false}
      onPointerEnter={cancelHoverClose}
      onPointerLeave={handleHoverOut}
      testID={testID}
    >
      <MenuPage depth={depth + 1}>{page.content}</MenuPage>
    </AnchoredSurface>
  );
}

function MenuSheetSurface({
  children,
  pages = [],
  sheetTitle,
  sheetTrailing,
  testID,
  keyboardFocusScope,
}: MenuSurfaceProps): ReactElement | null {
  const { height: windowHeight } = useWindowDimensions();
  const menu = useMenuContext("MenuSurface");
  const { value: surfaceValue } = useSubAnchors();
  const sheetDataSet = useMemo(
    () => (keyboardFocusScope ? { keyboardScope: keyboardFocusScope } : undefined),
    [keyboardFocusScope],
  );

  const handleClose = useCallback(() => menu.setOpen(false), [menu]);
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: menu.open,
    isEnabled: true,
    onClose: handleClose,
    // Android Back steps back through the pages before it closes the sheet.
    onBack: menu.goBack,
  });

  const openPageId = currentPageId(menu.path);
  const openPage = openPageId ? pages.find((page) => page.id === openPageId) : null;
  const depth = menu.path.length;
  const fillPage = openPage?.fill === true ? openPage : null;
  const listPage = openPage?.fill === true ? null : openPage;

  // The sheet's content is teleported out of this subtree, so both menu contexts have to be
  // rebuilt on the other side. Providing them around the modal instead would put them on the
  // wrong side of the portal and every item inside would throw. See `ContextBridge`.
  const contextBridge = useCallback<ContextBridge>(
    (content) => (
      <MenuContextProvider value={menu}>
        <MenuSurfaceContext.Provider value={surfaceValue}>{content}</MenuSurfaceContext.Provider>
      </MenuContextProvider>
    ),
    [menu, surfaceValue],
  );

  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      backgroundComponent={SheetBackground}
      handleComponent={SheetHandle}
      // Content-sized rather than fixed snap points: a pushed page is rarely the same height
      // as the page it replaced, and a fixed sheet would either clip it or leave dead space.
      // A fill page is the exception: it takes the height every full sheet has, and its own
      // content scrolls, so dragging it would fight that scroll.
      enableDynamicSizing={!fillPage}
      snapPoints={fillPage ? FULL_SHEET_SNAP_POINTS : undefined}
      enableContentPanningGesture={!fillPage}
      maxDynamicContentSize={windowHeight * 0.8}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backdropOpacity={0.45}
      enablePanDownToClose
      // `interactive` rather than `extend`, which is what every other sheet in the app uses.
      // `extend` grows the sheet to its largest snap point, and with `enableDynamicSizing` that
      // point is the content's own height — so a short page does not grow, the keyboard comes up
      // over it, and the field you are typing into is behind the keys. `interactive` moves the
      // sheet up instead, which is the only thing a content-sized sheet can usefully do.
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
    >
      {fillPage ? (
        <View style={styles.fillPage} testID={testID ? `${testID}-${fillPage.id}` : undefined}>
          {fillPage.content}
        </View>
      ) : (
        <MenuSheetScrollView dataSet={sheetDataSet} testID={testID}>
          {listPage ? (
            <>
              <MenuSheetHeader title={listPage.title} onBack={menu.goBack} />
              <MenuPage depth={depth}>{listPage.content}</MenuPage>
            </>
          ) : (
            <>
              {sheetTitle ? (
                <MenuSheetHeader title={sheetTitle} onBack={null} trailing={sheetTrailing} />
              ) : null}
              <MenuPage depth={0}>{children}</MenuPage>
            </>
          )}
        </MenuSheetScrollView>
      )}
    </IsolatedBottomSheetModal>
  );
}

/**
 * Rendered on the far side of the sheet's portal so it clears the screen's bottom inset, not the
 * one left where the menu was opened: inside a sheet tab, none is.
 */
function MenuSheetScrollView({
  dataSet,
  testID,
  children,
}: {
  dataSet: { keyboardScope: KeyboardFocusScope } | undefined;
  testID?: string;
  children: ReactNode;
}) {
  const safeAreaInsets = useSafeAreaInsets();
  const contentStyle = useMemo(
    () => ({
      paddingBottom: getMenuSheetBottomPadding({
        safeAreaBottom: safeAreaInsets.bottom,
        breathingRoom: SPACING[1],
      }),
    }),
    [safeAreaInsets.bottom],
  );
  return (
    <BottomSheetScrollView
      dataSet={dataSet}
      contentContainerStyle={contentStyle}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      testID={testID ? `${testID}-content` : undefined}
    >
      {children}
    </BottomSheetScrollView>
  );
}

function MenuSheetHeader({
  title,
  onBack,
  trailing = null,
}: {
  title: string;
  onBack: (() => void) | null;
  trailing?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.sheetHeader}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          hitSlop={8}
          onPress={onBack}
          style={styles.sheetBackButton}
          testID="menu-sheet-back"
        >
          <ThemedChevronLeft size={18} uniProps={mutedIconMapping} />
        </Pressable>
      ) : null}
      <Text style={styles.sheetTitle} numberOfLines={1}>
        {title}
      </Text>
      {trailing ? <View style={styles.sheetTrailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fillPage: {
    flex: 1,
    minHeight: 0,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[3],
  },
  sheetTrailing: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  sheetBackButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
}));

export { isSubPageOpen };
