import { useCallback, useContext, useMemo, useState } from "react";
import { requireNativeViewManager } from "expo-modules-core";
import { StyleSheet, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supportsModernWindowLayout } from "@/constants/modern-window-layout";
import { AppContentLeadingOffsetContext } from "@/contexts/app-content-width-context";
import { resolveLeadingCornerControlInset } from "./content-band-geometry.shared";
import {
  TopBarSafeAreaFrame,
  type TopBarGeometry,
  type TopBarSafeAreaProps,
} from "./top-bar-safe-area.shared";

export type { TopBarSafeAreaProps } from "./top-bar-safe-area.shared";

interface NativeGeometryViewProps extends ViewProps {
  contentHeight: number;
  primaryRowHeight: number;
  topPadding: number;
  horizontalContentPadding: number;
  navigationGroup: boolean;
  onGeometryChange: (event: NativeSyntheticEvent<TopBarGeometry>) => void;
}

const NativeGeometryView = supportsModernWindowLayout
  ? requireNativeViewManager<NativeGeometryViewProps>("PaseoWindowLayout")
  : null;

export function TopBarSafeArea({
  topPadding = 0,
  navigationGroup = false,
  onAvailableWidth,
  allocatedWidth,
  onHorizontalInsetsChange,
  ...props
}: TopBarSafeAreaProps) {
  const insets = useSafeAreaInsets();
  const allocatedLeadingOffset = useContext(AppContentLeadingOffsetContext);
  const [geometry, setGeometry] = useState<TopBarGeometry | null>(null);
  const handleGeometryChange = useCallback(
    ({ nativeEvent: next }: NativeSyntheticEvent<TopBarGeometry>) => {
      if (next.availableWidth < 0) return;
      if (allocatedWidth != null && Math.abs(next.ownerWidth - allocatedWidth) > 0.5) return;
      onHorizontalInsetsChange?.(next.left, next.right);
      setGeometry((previous) =>
        previous?.top === next.top &&
        previous.left === next.left &&
        previous.right === next.right &&
        previous.availableWidth === next.availableWidth &&
        previous.ownerLeadingOffset === next.ownerLeadingOffset &&
        previous.leadingCornerInset === next.leadingCornerInset &&
        previous.requiresLeadingCornerSlot === next.requiresLeadingCornerSlot &&
        previous.alignmentCenterY === next.alignmentCenterY
          ? previous
          : next,
      );
    },
    [allocatedWidth, onHorizontalInsetsChange],
  );
  const fallbackGeometry = useMemo(() => ({ top: insets.top, left: 0, right: 0 }), [insets.top]);
  const resolvedGeometry = useMemo(() => {
    if (!geometry) return fallbackGeometry;
    if (geometry.alignmentCenterY == null) return geometry;
    return {
      ...geometry,
      top: Math.max(
        0,
        geometry.alignmentCenterY -
          (props.primaryRowHeight ?? props.contentHeight) / 2 -
          topPadding,
      ),
    };
  }, [geometry, fallbackGeometry, props.primaryRowHeight, props.contentHeight, topPadding]);
  const probe = useMemo(
    () =>
      NativeGeometryView ? (
        <NativeGeometryView
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          contentHeight={props.contentHeight}
          primaryRowHeight={props.primaryRowHeight ?? props.contentHeight}
          topPadding={topPadding}
          horizontalContentPadding={props.horizontalContentPadding ?? 0}
          navigationGroup={navigationGroup}
          onGeometryChange={handleGeometryChange}
        />
      ) : null,
    [
      props.contentHeight,
      props.primaryRowHeight,
      props.horizontalContentPadding,
      topPadding,
      navigationGroup,
      handleGeometryChange,
    ],
  );
  let availableWidth: number | undefined;
  if (NativeGeometryView) {
    availableWidth = geometry?.availableWidth;
    if (allocatedWidth != null) {
      availableWidth = Math.max(0, allocatedWidth - (geometry?.left ?? 0) - (geometry?.right ?? 0));
    }
  }
  const leadingControlInset = geometry
    ? resolveLeadingCornerControlInset({
        leadingCornerInset: geometry.leadingCornerInset,
        requiresLeadingCornerSlot: geometry.requiresLeadingCornerSlot,
        leadingOffset: allocatedLeadingOffset ?? geometry.ownerLeadingOffset,
        rowHeight: props.primaryRowHeight ?? props.contentHeight,
        horizontalPadding: props.horizontalContentPadding ?? 0,
        leftInset: resolvedGeometry.left,
      })
    : 0;
  return (
    <TopBarSafeAreaFrame
      {...props}
      topPadding={topPadding}
      onAvailableWidth={onAvailableWidth}
      availableWidth={availableWidth}
      geometry={resolvedGeometry}
      leadingControlInset={leadingControlInset}
      probe={probe}
    />
  );
}
