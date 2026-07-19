import { useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TargetedEvent,
} from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
  type FieldControlSize,
} from "@/components/ui/control-geometry";
import { Field } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export interface SelectFieldDisplay {
  label: string;
  description?: string;
}

export interface SelectFieldOption<TValue> {
  id: string;
  value: TValue;
  label: string;
  description?: string;
  kind?: ComboboxOption["kind"];
  testID?: string;
}

export interface SelectFieldRenderOptionInput<TValue> {
  option: SelectFieldOption<TValue>;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}

export interface SelectFieldProps<TValue> {
  label: string;
  value: TValue | null;
  selectedDisplay: SelectFieldDisplay | null;
  options: SelectFieldOption<TValue>[];
  onChange: (value: TValue, display: SelectFieldDisplay) => void;
  placeholder: string;
  emptyText: string;
  loading?: boolean;
  disabled?: boolean;
  hint?: string;
  error?: string | null;
  searchable?: boolean;
  searchPlaceholder?: string;
  title?: string;
  size?: FieldControlSize;
  getValueKey?: (value: TValue) => string;
  renderOption?: (input: SelectFieldRenderOptionInput<TValue>) => ReactElement;
  triggerLeading?: ReactNode;
  field?: boolean;
  testID?: string;
  triggerTestID?: string;
}

export interface SelectFieldTriggerProps {
  display?: SelectFieldDisplay | null;
  label?: string;
  isPlaceholder?: boolean;
  placeholder: string;
  hovered?: boolean;
  focused?: boolean;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
  leading?: ReactNode;
  size?: FieldControlSize;
  testID?: string;
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function getSelectedOptionId<TValue>(
  options: readonly SelectFieldOption<TValue>[],
  value: TValue | null,
  getValueKey: ((value: TValue) => string) | undefined,
): string {
  if (value === null) {
    return "";
  }
  if (getValueKey) {
    const selectedKey = getValueKey(value);
    return options.find((option) => getValueKey(option.value) === selectedKey)?.id ?? "";
  }
  return options.find((option) => Object.is(option.value, value))?.id ?? "";
}

function useVisibleSelectOptions<TValue>(
  options: SelectFieldOption<TValue>[],
  loading: boolean,
): SelectFieldOption<TValue>[] {
  const previousOptionsRef = useRef<SelectFieldOption<TValue>[]>(options);
  if (options.length > 0 || !loading) {
    previousOptionsRef.current = options;
  }
  if (loading && options.length === 0) {
    return previousOptionsRef.current;
  }
  return options;
}

export function SelectFieldTrigger({
  display,
  label: explicitLabel,
  isPlaceholder: explicitIsPlaceholder,
  placeholder,
  hovered = false,
  focused = false,
  active = false,
  disabled = false,
  loading = false,
  leading,
  size = "md",
  testID,
}: SelectFieldTriggerProps): ReactElement {
  const sizeStyle = size === "sm" ? styles.triggerSm : styles.triggerMd;
  const textSizeStyle = size === "sm" ? styles.triggerTextSm : styles.triggerTextMd;
  const triggerStyle = useMemo(
    () => [
      styles.trigger,
      sizeStyle,
      resolveControlInteractionStyles(
        {
          controlRest: styles.controlRest,
          controlHover: styles.controlHover,
          controlActive: styles.controlActive,
          controlDisabled: styles.controlDisabled,
        },
        { hovered, focused, active, disabled },
      ),
    ],
    [active, disabled, focused, hovered, sizeStyle],
  );
  const label = explicitLabel ?? display?.label ?? placeholder;
  const isPlaceholder = explicitIsPlaceholder ?? display == null;
  const textStyle = useMemo(
    () => [isPlaceholder ? styles.placeholderText : styles.triggerText, textSizeStyle],
    [isPlaceholder, textSizeStyle],
  );

  return (
    <View pointerEvents="none" style={triggerStyle} testID={testID}>
      {leading}
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
      {loading ? (
        <View style={styles.spinnerSlot}>
          <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        </View>
      ) : null}
      <ThemedChevronDown size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
    </View>
  );
}

export function SelectField<TValue>({
  label,
  value,
  selectedDisplay,
  options,
  onChange,
  placeholder,
  emptyText,
  loading = false,
  disabled = false,
  hint,
  error,
  searchable = false,
  searchPlaceholder,
  title,
  size = "md",
  getValueKey,
  renderOption,
  triggerLeading,
  field = true,
  testID,
  triggerTestID,
}: SelectFieldProps<TValue>): ReactElement {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [triggerFocused, setTriggerFocused] = useState(false);
  const visibleOptions = useVisibleSelectOptions(options, loading);
  const selectedOptionId = useMemo(
    () => getSelectedOptionId(visibleOptions, value, getValueKey),
    [getValueKey, value, visibleOptions],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(
    () =>
      visibleOptions.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        kind: option.kind,
      })),
    [visibleOptions],
  );
  const optionById = useMemo(
    () => new Map(visibleOptions.map((option) => [option.id, option])),
    [visibleOptions],
  );

  const handleSelect = useCallback(
    (id: string) => {
      const option = optionById.get(id);
      if (!option) {
        return;
      }
      onChange(option.value, { label: option.label, description: option.description });
      setOpen(false);
    },
    [onChange, optionById],
  );

  const handlePress = useCallback(() => {
    if (disabled) {
      return;
    }
    setOpen((current) => !current);
  }, [disabled]);
  const handleTriggerFocus = useCallback((_event: NativeSyntheticEvent<TargetedEvent>) => {
    setTriggerFocused(true);
  }, []);
  const handleTriggerBlur = useCallback((_event: NativeSyntheticEvent<TargetedEvent>) => {
    setTriggerFocused(false);
  }, []);

  const renderComboboxOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      const selectOption = optionById.get(option.id);
      if (!selectOption) {
        return (
          <ComboboxItem
            label={option.label}
            description={option.description}
            kind={option.kind}
            selected={selected}
            active={active}
            onPress={onPress}
          />
        );
      }
      if (renderOption) {
        return renderOption({ option: selectOption, selected, active, onPress });
      }
      return (
        <ComboboxItem
          testID={selectOption.testID}
          label={selectOption.label}
          description={selectOption.description}
          kind={selectOption.kind}
          selected={selected}
          active={active}
          onPress={onPress}
        />
      );
    },
    [optionById, renderOption],
  );

  const displayLabel = selectedDisplay?.label ?? placeholder;
  const fieldHint = selectedDisplay?.description ?? hint;

  const control = (
    <>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handlePress}
          onFocus={handleTriggerFocus}
          onBlur={handleTriggerBlur}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${label} (${displayLabel})`}
          testID={triggerTestID}
        >
          {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
            <SelectFieldTrigger
              display={selectedDisplay}
              placeholder={placeholder}
              hovered={Boolean(hovered)}
              focused={triggerFocused}
              active={pressed || open}
              disabled={disabled}
              loading={loading}
              leading={triggerLeading}
              size={size}
            />
          )}
        </Pressable>
      </View>
      <Combobox
        options={comboboxOptions}
        value={selectedOptionId}
        onSelect={handleSelect}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
        emptyText={loading && visibleOptions.length === 0 ? "Loading..." : emptyText}
        title={title ?? label}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        renderOption={renderComboboxOption}
      />
    </>
  );

  if (!field) {
    return <View testID={testID}>{control}</View>;
  }

  return (
    <Field label={label} hint={fieldHint} error={error} testID={testID}>
      {control}
    </Field>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      backgroundColor: theme.colors.surface2,
    },
    triggerSm: {
      ...geometry.fieldControlSm,
    },
    triggerMd: {
      ...geometry.fieldControlMd,
    },
    controlRest: {
      ...geometry.controlRest,
    },
    controlHover: {
      ...geometry.controlHover,
    },
    controlActive: {
      ...geometry.controlActive,
    },
    controlDisabled: {
      ...geometry.controlDisabled,
    },
    triggerText: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
    },
    placeholderText: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foregroundMuted,
    },
    triggerTextSm: {
      ...geometry.fieldTextSm,
    },
    triggerTextMd: {
      ...geometry.fieldTextMd,
    },
    spinnerSlot: {
      flexShrink: 0,
      width: ICON_SIZE.md,
      alignItems: "center",
    },
  };
});
