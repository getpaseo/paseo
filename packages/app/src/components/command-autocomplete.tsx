import { useCallback, useEffect, useRef } from "react";
import { ScrollView, Text, View, Pressable, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Theme } from "@/styles/theme";
import {
  getCommandAutocompleteScrollOffset,
  type AgentSlashCommand,
} from "./command-autocomplete-utils";

interface CommandAutocompleteProps {
  commands: AgentSlashCommand[];
  selectedIndex: number;
  onSelect: (command: AgentSlashCommand) => void;
  isLoading: boolean;
  errorMessage?: string;
}

export function CommandAutocomplete({
  commands,
  selectedIndex,
  onSelect,
  isLoading,
  errorMessage,
}: CommandAutocompleteProps) {
  const scrollRef = useRef<ScrollView>(null);
  const rowLayoutsRef = useRef<Map<number, { top: number; height: number }>>(new Map());
  const viewportHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);

  const ensureActiveItemVisible = useCallback(() => {
    if (selectedIndex < 0) {
      return;
    }

    const layout = rowLayoutsRef.current.get(selectedIndex);
    if (!layout) {
      return;
    }

    const nextOffset = getCommandAutocompleteScrollOffset({
      currentOffset: scrollOffsetRef.current,
      viewportHeight: viewportHeightRef.current,
      itemTop: layout.top,
      itemHeight: layout.height,
    });

    if (Math.abs(nextOffset - scrollOffsetRef.current) < 1) {
      return;
    }

    scrollOffsetRef.current = nextOffset;
    scrollRef.current?.scrollTo({ y: nextOffset, animated: false });
  }, [selectedIndex]);

  const pinToBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    });
  }, []);

  useEffect(() => {
    rowLayoutsRef.current.clear();
    scrollOffsetRef.current = 0;
  }, [commands]);

  useEffect(() => {
    if (commands.length === 0) {
      return;
    }
    pinToBottom();
  }, [commands, pinToBottom]);

  useEffect(() => {
    const raf = requestAnimationFrame(ensureActiveItemVisible);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [ensureActiveItemVisible, commands.length]);

  const handleScrollViewLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height;
      ensureActiveItemVisible();
    },
    [ensureActiveItemVisible]
  );

  const handleRowLayout = useCallback(
    (index: number, event: LayoutChangeEvent) => {
      rowLayoutsRef.current.set(index, {
        top: event.nativeEvent.layout.y,
        height: event.nativeEvent.layout.height,
      });
      ensureActiveItemVisible();
    },
    [ensureActiveItemVisible]
  );

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>Loading commands...</Text>
        </View>
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>Error: {errorMessage}</Text>
        </View>
      </View>
    );
  }

  if (commands.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>No commands found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        onLayout={handleScrollViewLayout}
        onContentSizeChange={pinToBottom}
        onScroll={(event) => {
          scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="always"
      >
        {commands.map((cmd, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Pressable
              key={cmd.name}
              onLayout={(event) => handleRowLayout(index, event)}
              onPress={() => onSelect(cmd)}
              style={({ hovered = false, pressed }) => [
                styles.commandItem,
                (hovered || pressed || isSelected) && styles.commandItemActive,
              ]}
            >
              <View style={styles.commandMain}>
                <View style={styles.commandHeader}>
                  <Text style={styles.commandName}>/{cmd.name}</Text>
                  {cmd.argumentHint ? (
                    <Text style={styles.commandArgs}>{cmd.argumentHint}</Text>
                  ) : null}
                </View>
                <Text style={styles.commandDescription} numberOfLines={1}>
                  {cmd.description}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(((theme: Theme) => ({
  container: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    maxHeight: 220,
    overflow: "hidden",
  },
  scrollView: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  commandItem: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  commandItemActive: {
    backgroundColor: theme.colors.surface1,
  },
  commandMain: {
    flex: 1,
    minWidth: 0,
  },
  commandHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  commandName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  commandArgs: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  commandDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
  },
  emptyItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
})) as any) as Record<string, any>;
