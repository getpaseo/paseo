import { createContext, useContext, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

interface HorizontalScrollContextValue {
  // Shared value indicating that an embedded interaction surface owns the active touch.
  isGestureSuppressed: SharedValue<boolean>;
  // Shared value indicating if any registered horizontal scroll is scrolled (offset > 0)
  isAnyScrolledRight: SharedValue<boolean>;
  // Register a scroll view's offset - returns an unregister function
  registerScrollOffset: (id: string, offset: number) => void;
  unregisterScrollOffset: (id: string) => void;
}

const HorizontalScrollContext = createContext<HorizontalScrollContextValue | null>(null);

export function HorizontalScrollProvider({ children }: { children: ReactNode }) {
  const isGestureSuppressed = useSharedValue(false);
  const isAnyScrolledRight = useSharedValue(false);
  const scrollOffsetsRef = useRef<Map<string, number>>(new Map());

  const updateIsAnyScrolled = useCallback(() => {
    let anyScrolled = false;
    for (const offset of scrollOffsetsRef.current.values()) {
      if (offset > 1) {
        anyScrolled = true;
        break;
      }
    }
    isAnyScrolledRight.value = anyScrolled;
  }, [isAnyScrolledRight]);

  const registerScrollOffset = useCallback(
    (id: string, offset: number) => {
      scrollOffsetsRef.current.set(id, offset);
      updateIsAnyScrolled();
    },
    [updateIsAnyScrolled],
  );

  const unregisterScrollOffset = useCallback(
    (id: string) => {
      scrollOffsetsRef.current.delete(id);
      updateIsAnyScrolled();
    },
    [updateIsAnyScrolled],
  );

  const contextValue = useMemo(
    () => ({
      isGestureSuppressed,
      isAnyScrolledRight,
      registerScrollOffset,
      unregisterScrollOffset,
    }),
    [isAnyScrolledRight, isGestureSuppressed, registerScrollOffset, unregisterScrollOffset],
  );

  return (
    <HorizontalScrollContext.Provider value={contextValue}>
      {children}
    </HorizontalScrollContext.Provider>
  );
}

export function useHorizontalScroll() {
  const context = useContext(HorizontalScrollContext);
  if (!context) {
    throw new Error("useHorizontalScroll must be used within HorizontalScrollProvider");
  }
  return context;
}

export function useHorizontalScrollOptional() {
  return useContext(HorizontalScrollContext);
}
