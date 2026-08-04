import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BottomSheetBackdrop, BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { ChevronLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
  type ContextBridge,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { SPACING, type Theme } from "@/styles/theme";
import { useMenuContext, MenuContextProvider } from "./menu-context";
import { MenuPage } from "./menu-item";
import { currentPageId, isSubPageOpen } from "./menu-navigation";
import { AnchoredSurface, MenuOverlay } from "./menu-overlay";
import { getMenuSheetBottomPadding } from "./menu-sheet-layout";
import type { Alignment, Placement } from "./menu-anchor";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// `backgroundStyle` and `handleIndicatorStyle` are style-shaped props the Babel plugin does not
// track, so the sheet is wrapped rather than reading the theme through a hook.
// See docs/unistyles.md.
const ThemedBottomSheetModal = withUnistyles(IsolatedBottomSheetModal, (theme) => ({
  backgroundStyle: {
    borderTopLeftRadius: theme.borderRadius.xl,
    borderTopRightRadius: theme.borderRadius.xl,
    borderWidth: 1,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
  },
  handleIndicatorStyle: {
    width: 36,
    height: 4,
    backgroundColor: theme.colors.surface2,
  },
}));

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

export interface MenuPageDefinition {
  id: string;
  title: string;
  content: ReactNode;
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
}

/**
 * The open menu. Reads its presentation from the menu root and renders either an anchored
 * popover (plus one flyout per open submenu) or a bottom sheet showing one page at a time.
 */
export function MenuSurface(props: MenuSurfaceProps): ReactElement | null {
  const { presentation } = useMenuContext("MenuSurface");
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

  return (
    <MenuSurfaceContext.Provider value={surfaceValue}>
      <MenuOverlay visible={menu.open} onClose={handleClose}>
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
      revision={page.id}
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
  testID,
}: MenuSurfaceProps): ReactElement | null {
  const menu = useMenuContext("MenuSurface");
  const { value: surfaceValue } = useSubAnchors();
  const safeAreaInsets = useSafeAreaInsets();

  const sheetScrollContentStyle = useMemo(
    () => ({
      paddingBottom: getMenuSheetBottomPadding({
        safeAreaBottom: safeAreaInsets.bottom,
        breathingRoom: SPACING[1],
      }),
    }),
    [safeAreaInsets.bottom],
  );

  const handleClose = useCallback(() => menu.setOpen(false), [menu]);
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: menu.open,
    isEnabled: true,
    onClose: handleClose,
  });

  const renderBackdrop = useCallback(
    (backdropProps: ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.45}
      />
    ),
    [],
  );

  const openPageId = currentPageId(menu.path);
  const openPage = openPageId ? pages.find((page) => page.id === openPageId) : null;
  const depth = menu.path.length;

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
    <ThemedBottomSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      // Content-sized rather than fixed snap points: a pushed page is rarely the same height
      // as the page it replaced, and a fixed sheet would either clip it or leave dead space.
      enableDynamicSizing
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
    >
      <BottomSheetScrollView
        contentContainerStyle={sheetScrollContentStyle}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        testID={testID ? `${testID}-content` : undefined}
      >
        {openPage ? (
          <>
            <MenuSheetHeader title={openPage.title} onBack={menu.goBack} />
            <MenuPage depth={depth}>{openPage.content}</MenuPage>
          </>
        ) : (
          <>
            {sheetTitle ? <MenuSheetHeader title={sheetTitle} onBack={null} /> : null}
            <MenuPage depth={0}>{children}</MenuPage>
          </>
        )}
      </BottomSheetScrollView>
    </ThemedBottomSheetModal>
  );
}

function MenuSheetHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: (() => void) | null;
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[3],
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
