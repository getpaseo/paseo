import { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { Check, ChevronDown } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import type {
  BrowserElementField,
  BrowserElementJson,
  BrowserElementOption,
} from "@/desktop/browser/element-context";
import {
  browserElementValueKey,
  browserElementValuesEqual,
  formatBrowserElementFieldValue,
  isBrowserElementFieldValueValid,
  parseBrowserElementFieldValue,
} from "@/desktop/browser/element-context-field-value";
import { elementContextFieldStyles as styles } from "@/desktop/browser/element-context-fields.styles.electron";
import { NativeElementContextField } from "@/desktop/browser/element-context-native-field.electron";
import type { Theme } from "@/styles/theme";

export type BrowserElementFieldGroup = [string, BrowserElementField[]];

interface ElementContextFieldsProps {
  groups: BrowserElementFieldGroup[];
  isGenericContext: boolean;
  values: Record<string, BrowserElementJson>;
  onChange: (fieldId: string, value: BrowserElementJson) => void;
}

function toSelectOptions(
  options: readonly BrowserElementOption[],
): SelectFieldOption<BrowserElementJson>[] {
  return options
    .filter((option) => option.disabled !== true)
    .map((option, index) => ({
      id: `${index}:${browserElementValueKey(option.value)}`,
      value: option.value,
      label: option.label,
    }));
}

const emptyOptions: BrowserElementOption[] = [];

function SyncedTextInput({
  field,
  value,
  disabled,
  multiline = false,
  onChange,
}: {
  field: BrowserElementField;
  value: string;
  disabled: boolean;
  multiline?: boolean;
  onChange: (value: BrowserElementJson) => void;
}) {
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const currentValueRef = useRef(value);
  const handleChange = useCallback(
    (next: string) => {
      currentValueRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  useEffect(() => {
    if (currentValueRef.current === value) return;
    currentValueRef.current = value;
    inputRef.current?.replaceText(value);
  }, [value]);

  return (
    <ThemedFieldInput
      accessibilityLabel={field.label}
      editable={!disabled}
      initialValue={value}
      multiline={multiline}
      onChangeText={handleChange}
      placeholder={field.placeholder}
      ref={inputRef}
      style={[styles.input, multiline ? styles.multilineInput : null]}
      uniProps={inputMapping}
    />
  );
}

function optionRowStyle({ hovered }: PressableStateCallbackType) {
  return [styles.optionRow, hovered ? styles.optionRowHovered : null];
}

function MultiSelectOptionRow({
  disabled,
  onChange,
  option,
  selected,
}: {
  disabled: boolean;
  onChange: (value: BrowserElementJson) => void;
  option: BrowserElementOption;
  selected: BrowserElementJson[];
}) {
  const checked = selected.some((item) => browserElementValuesEqual(item, option.value));
  const isDisabled = disabled || option.disabled === true;
  const accessibilityState = useMemo(
    () => ({ checked, disabled: isDisabled }),
    [checked, isDisabled],
  );
  const handlePress = useCallback(() => {
    const next = checked
      ? selected.filter((item) => !browserElementValuesEqual(item, option.value))
      : [...selected, option.value];
    onChange(next);
  }, [checked, onChange, option.value, selected]);

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      disabled={isDisabled}
      onPress={handlePress}
      style={optionRowStyle}
    >
      <View style={[styles.checkbox, checked ? styles.checkboxSelected : null]}>
        {checked ? <ThemedCheck size={12} uniProps={selectedIconMapping} /> : null}
      </View>
      <Text style={styles.optionLabel}>{option.label}</Text>
    </Pressable>
  );
}

function FieldValueControl({
  disabled,
  displayValue,
  field,
  multiline,
  onChange,
  onTextChange,
  invalid,
}: {
  disabled: boolean;
  displayValue: string;
  field: BrowserElementField;
  multiline: boolean;
  onChange: (value: BrowserElementJson) => void;
  onTextChange: (value: BrowserElementJson) => void;
  invalid: boolean;
}) {
  const nativeEditor = ["color", "number", "slider", "date", "time", "datetime"].includes(
    field.editor,
  );
  const textEditor = !["number", "slider", "date", "time", "datetime"].includes(field.editor);
  return (
    <View
      style={[
        styles.inputWrap,
        multiline ? styles.stackedControl : null,
        invalid ? styles.invalidInputWrap : null,
      ]}
    >
      {nativeEditor ? (
        <NativeElementContextField
          disabled={disabled}
          field={field}
          onChange={onChange}
          value={displayValue}
        />
      ) : null}
      {textEditor ? (
        <SyncedTextInput
          disabled={disabled}
          field={field}
          value={displayValue}
          multiline={multiline}
          onChange={field.editor === "color" ? onChange : onTextChange}
        />
      ) : null}
      {field.unit ? <Text style={styles.unit}>{field.unit}</Text> : null}
    </View>
  );
}

function EditableField({
  field,
  isGenericContext,
  value,
  onChange,
}: {
  field: BrowserElementField;
  isGenericContext: boolean;
  value: BrowserElementJson;
  onChange: (fieldId: string, value: BrowserElementJson) => void;
}) {
  const { t } = useTranslation();
  const disabled = field.disabled === true || field.readOnly === true;
  const options = field.options ?? emptyOptions;
  const selectedOption = options.find((option) => browserElementValuesEqual(option.value, value));
  const selectOptions = useMemo(() => toSelectOptions(options), [options]);
  const selectedDisplay = useMemo(
    () => (selectedOption ? { label: selectedOption.label } : null),
    [selectedOption],
  );
  const changeValue = useCallback(
    (next: BrowserElementJson) => onChange(field.id, next),
    [field.id, onChange],
  );
  const changeText = useCallback(
    (next: string) => changeValue(parseBrowserElementFieldValue(field, next)),
    [changeValue, field],
  );
  const changeJsonText = useCallback(
    (next: BrowserElementJson) => changeText(String(next ?? "")),
    [changeText],
  );

  if (isGenericContext && field.id === "font-family") {
    return (
      <View style={styles.fieldRow}>
        <FieldLabel field={field} />
        <View style={styles.inputWrap}>
          <SyncedTextInput
            disabled={disabled}
            field={field}
            onChange={changeValue}
            value={formatBrowserElementFieldValue(value, false)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              accessibilityLabel={`${field.label}: ${t("common.actions.select")}`}
              accessibilityRole="button"
              disabled={disabled}
              style={styles.fontPresetsTrigger}
              testID="element-context-font-presets"
            >
              <ThemedChevronDown size={16} uniProps={mutedIconMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {options.map((option) => (
                <FontPresetOption
                  key={browserElementValueKey(option.value)}
                  onChange={changeValue}
                  option={option}
                  value={value}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    );
  }

  if (field.editor === "boolean") {
    return (
      <View style={styles.fieldRow}>
        <FieldLabel field={field} />
        <View style={styles.booleanControl}>
          <Switch
            accessibilityLabel={field.label}
            disabled={disabled}
            value={value === true}
            onValueChange={changeValue}
          />
        </View>
      </View>
    );
  }

  if ((field.editor === "select" || field.editor === "radio") && options.length > 0) {
    return (
      <View style={styles.fieldRow}>
        <FieldLabel field={field} />
        <View style={styles.fieldControl}>
          <SelectField
            disabled={disabled}
            emptyText={t("common.empty.noOptionsMatchSearch")}
            field={false}
            getValueKey={browserElementValueKey}
            label={field.label}
            onChange={changeValue}
            options={selectOptions}
            placeholder={field.placeholder ?? t("common.actions.select")}
            selectedDisplay={selectedDisplay}
            size="sm"
            value={value}
          />
        </View>
      </View>
    );
  }

  if ((field.editor === "multiselect" || field.editor === "checkbox-group") && options.length > 0) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <View style={styles.stackedField}>
        <FieldLabel field={field} stacked />
        <View style={styles.optionList}>
          {options.map((option) => (
            <MultiSelectOptionRow
              disabled={disabled}
              key={browserElementValueKey(option.value)}
              onChange={changeValue}
              option={option}
              selected={selected}
            />
          ))}
        </View>
      </View>
    );
  }

  const structured = ["json", "code", "key-value", "table", "custom"].includes(field.editor);
  const multiline = field.editor === "textarea" || structured;
  const displayValue = formatBrowserElementFieldValue(value, structured);
  const invalid = !isBrowserElementFieldValueValid(field, value);
  return (
    <View style={multiline ? styles.stackedField : styles.fieldRow}>
      <FieldLabel field={field} stacked={multiline} />
      <FieldValueControl
        disabled={disabled}
        displayValue={displayValue}
        field={field}
        multiline={multiline}
        invalid={invalid}
        onChange={changeValue}
        onTextChange={changeJsonText}
      />
    </View>
  );
}

function FontPresetOption({
  option,
  value,
  onChange,
}: {
  option: BrowserElementOption;
  value: BrowserElementJson;
  onChange: (value: BrowserElementJson) => void;
}) {
  const handleSelect = useCallback(() => onChange(option.value), [onChange, option.value]);
  return (
    <DropdownMenuItem
      disabled={option.disabled}
      onSelect={handleSelect}
      selected={browserElementValuesEqual(option.value, value)}
    >
      {option.label}
    </DropdownMenuItem>
  );
}

function FieldLabel({ field, stacked = false }: { field: BrowserElementField; stacked?: boolean }) {
  return (
    <View style={[styles.labelWrap, stacked ? styles.stackedLabelWrap : null]}>
      <Text numberOfLines={2} style={styles.label}>
        {field.label}
      </Text>
      {field.description ? (
        <Text numberOfLines={2} style={styles.description}>
          {field.description}
        </Text>
      ) : null}
    </View>
  );
}

function groupLabel(
  group: string,
  isGenericContext: boolean,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (!isGenericContext) return group;
  if (group === "Content") return t("workspace.browser.annotate.groups.content");
  if (group === "Appearance") return t("workspace.browser.annotate.groups.appearance");
  if (group === "Properties") return t("workspace.browser.annotate.groups.properties");
  return group;
}

export function ElementContextFields({
  groups,
  isGenericContext,
  values,
  onChange,
}: ElementContextFieldsProps) {
  const { t } = useTranslation();
  if (groups.length === 0) return null;
  return (
    <ScrollView contentContainerStyle={styles.fields} style={styles.scroller}>
      {groups.map(([group, groupFields]) => (
        <View key={group} style={styles.group}>
          <Text style={styles.groupLabel}>{groupLabel(group, isGenericContext, t)}</Text>
          {groupFields.map((field) => (
            <EditableField
              field={field}
              isGenericContext={isGenericContext}
              key={field.id}
              onChange={onChange}
              value={values[field.id] ?? null}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const ThemedFieldInput = withUnistyles(TextInput);
const ThemedCheck = withUnistyles(Check);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const inputMapping = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });
const selectedIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
