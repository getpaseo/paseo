import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DraggableList } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import type { UsageReportEntry } from "./types";

function reportKey(entry: UsageReportEntry): string {
  return entry.id;
}

/**
 * One card per shown report (source + account), in the user's order. Each card drags by its handle.
 * Window rows pin while the sidebar summary is on.
 */
export function UsageList({
  serverId,
  reports,
  display,
}: {
  serverId: string;
  reports: UsageReportEntry[];
  display: UsageDisplay;
}) {
  const { inSidebar } = useUsageInSidebar();
  const { arrangeCards } = display;
  const handleDragEnd = useCallback(
    (next: UsageReportEntry[], moved: string) =>
      arrangeCards({ moved, after: next.map(reportKey) }),
    [arrangeCards],
  );
  const renderItem = useCallback(
    ({ item, isActive }: DraggableRenderItemInfo<UsageReportEntry>) => (
      <View style={styles.item}>
        <UsageListCard
          serverId={serverId}
          entry={item}
          display={display}
          pinnable={inSidebar}
          dragging={isActive}
        />
      </View>
    ),
    [display, inSidebar, serverId],
  );
  return (
    <DraggableList
      data={reports}
      keyExtractor={reportKey}
      renderItem={renderItem}
      onDragEnd={handleDragEnd}
      extraData={display}
      scrollEnabled={false}
      useDragHandle
      containerStyle={styles.list}
      testID="usage-list"
    />
  );
}

/**
 * The card inside its hover target: the drag handle shows while the pointer is over the card or
 * keyboard focus is inside it, and always where there is no hover.
 */
function UsageListCard({
  serverId,
  entry,
  display,
  pinnable,
  dragging,
}: {
  serverId: string;
  entry: UsageReportEntry;
  display: UsageDisplay;
  pinnable: boolean;
  dragging: boolean;
}) {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  // Focus events bubble from the card's controls, so tabbing onto the handle reveals it.
  const [hasFocus, setHasFocus] = useState(false);
  const handleFocus = useCallback(() => setHasFocus(true), []);
  const handleBlur = useCallback(() => setHasFocus(false), []);
  const arrangement = useMemo(
    () => ({
      handleVisible: isHovered || hasFocus || dragging || isNative || isCompact,
    }),
    [dragging, hasFocus, isCompact, isHovered],
  );
  return (
    <View
      style={styles.hoverTarget}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <View style={settingsStyles.card}>
        <UsageCard
          serverId={serverId}
          entry={entry}
          display={display}
          pinnable={pinnable}
          refreshable
          arrangement={arrangement}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Each card carries the gap below it, so a native drag moves it with its slot; the list
  // takes the last one back.
  list: {
    marginBottom: -theme.spacing[3],
  },
  item: {
    paddingBottom: theme.spacing[3],
  },
  hoverTarget: {
    position: "relative",
  },
}));
