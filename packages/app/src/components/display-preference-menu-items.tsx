import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const backLeading = <ThemedChevronLeft size={14} uniProps={mutedColorMapping} />;

export interface DisplayPreferenceOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

export interface DisplayPreferencePage<Page extends string> {
  page: Page;
  label: string;
  value: string;
}

export function displayPreferenceOptionLabel<Value extends string>(
  options: readonly DisplayPreferenceOption<Value>[],
  value: Value,
  fallback: string,
): string {
  return options.find((option) => option.value === value)?.label ?? fallback;
}

export function DisplayPreferencePageLinks<Page extends string>({
  pages,
  testIDPrefix,
  onOpen,
}: {
  pages: readonly DisplayPreferencePage<Page>[];
  testIDPrefix?: string;
  onOpen: (page: Page) => void;
}) {
  return pages.map((page) => (
    <DisplayPreferencePageLink
      key={page.page}
      descriptor={page}
      testIDPrefix={testIDPrefix}
      onOpen={onOpen}
    />
  ));
}

function DisplayPreferencePageLink<Page extends string>({
  descriptor,
  testIDPrefix,
  onOpen,
}: {
  descriptor: DisplayPreferencePage<Page>;
  testIDPrefix?: string;
  onOpen: (page: Page) => void;
}) {
  const handleSelect = useCallback(() => onOpen(descriptor.page), [descriptor.page, onOpen]);
  const trailing = useMemo(
    () => (
      <View style={styles.pageValue}>
        <Text numberOfLines={1} style={styles.pageValueText}>
          {descriptor.value}
        </Text>
        <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
      </View>
    ),
    [descriptor.value],
  );
  return (
    <DropdownMenuItem
      closeOnSelect={false}
      testID={testIDPrefix ? `${testIDPrefix}-${descriptor.page}` : undefined}
      trailing={trailing}
      onSelect={handleSelect}
    >
      {descriptor.label}
    </DropdownMenuItem>
  );
}

export function DisplayPreferenceSubmenu({
  title,
  children,
  onBack,
}: {
  title: string;
  children: ReactNode;
  onBack: () => void;
}) {
  return (
    <>
      <DropdownMenuItem leading={backLeading} closeOnSelect={false} onSelect={onBack}>
        {title}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {children}
    </>
  );
}

interface PreferenceMenuItemProps<Value extends string> {
  item: DisplayPreferenceOption<Value>;
  selected: boolean;
  selectionRole: "radio" | "checkbox";
  closeOnSelect?: boolean;
  testIDPrefix?: string;
  onSelect: (value: Value) => void;
}

function PreferenceMenuItem<Value extends string>({
  item,
  selected,
  selectionRole,
  closeOnSelect,
  testIDPrefix,
  onSelect,
}: PreferenceMenuItemProps<Value>) {
  const handleSelect = useCallback(() => onSelect(item.value), [item.value, onSelect]);
  return (
    <DropdownMenuItem
      testID={testIDPrefix ? `${testIDPrefix}-${item.value}` : undefined}
      selected={selected}
      selectionRole={selectionRole}
      disabled={item.disabled}
      closeOnSelect={closeOnSelect}
      onSelect={handleSelect}
    >
      {item.label}
    </DropdownMenuItem>
  );
}

export function SingleSelectPreferenceItems<Value extends string>({
  items,
  selected,
  closeOnSelect,
  testIDPrefix,
  onSelect,
}: {
  items: readonly DisplayPreferenceOption<Value>[];
  selected: Value;
  closeOnSelect?: boolean;
  testIDPrefix?: string;
  onSelect: (value: Value) => void;
}) {
  return items.map((item) => (
    <PreferenceMenuItem
      key={item.value}
      item={item}
      selected={selected === item.value}
      selectionRole="radio"
      closeOnSelect={closeOnSelect}
      testIDPrefix={testIDPrefix}
      onSelect={onSelect}
    />
  ));
}

export function MultiSelectPreferenceItems<Value extends string>({
  allLabel,
  items,
  selected,
  testIDPrefix,
  onClear,
  onToggle,
}: {
  allLabel: string;
  items: readonly DisplayPreferenceOption<Value>[];
  selected: readonly Value[];
  testIDPrefix?: string;
  onClear: () => void;
  onToggle: (value: Value) => void;
}) {
  return (
    <>
      <DropdownMenuItem
        selected={selected.length === 0}
        selectionRole="checkbox"
        closeOnSelect={false}
        testID={testIDPrefix ? `${testIDPrefix}-all` : undefined}
        onSelect={onClear}
      >
        {allLabel}
      </DropdownMenuItem>
      {items.map((item) => (
        <PreferenceMenuItem
          key={item.value}
          item={item}
          selected={selected.includes(item.value)}
          selectionRole="checkbox"
          closeOnSelect={false}
          testIDPrefix={testIDPrefix}
          onSelect={onToggle}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  pageValue: {
    maxWidth: 156,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  pageValueText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
