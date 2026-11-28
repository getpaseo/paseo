import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { getModeVisuals, type AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { getAgentModeOptionIcon } from "@/agent-controls/icons";
import { formatAgentModeLabel } from "@/agent-controls/labels";
import {
  SettingsCard,
  SettingsDetailRow,
  SettingsSection,
  SettingsSwitch,
} from "@/components/settings";
import type { ComboboxOption } from "@/components/ui/combobox";
import { foregroundIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView as SheetScrollView } from "@/components/ui/scroll-view";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SteppedSlider, type SteppedSliderOption } from "@/components/ui/stepped-slider";
import { isNative } from "@/constants/platform";
import { ICON_SIZE } from "@/styles/theme";
import {
  ComposerControlIcon,
  usePendingRun,
  type ComposerControlChoice,
  type ComposerControlItem,
} from "./composer-control";
import type { AgentModeControlValue } from "./mode-control";
import { layoutSheetHome, type SheetHomeBlock, type SheetHomeRow } from "./sheet-control-layout";

const ThemedCheck = withUnistyles(Check);
const KEYBOARD_DISMISS_MODE = isNative ? "on-drag" : "none";

/** The controls the agent settings sheet draws on its Home page, by kind. */
export interface AgentSheetControls {
  thinkingItems: readonly ComposerControlItem[];
  featureItems: readonly ComposerControlItem[];
  modeControl: AgentModeControlValue | null;
}

/** The select page id of the agent's mode, beside the ids of the composer controls. */
export const AGENT_SHEET_MODE_CONTROL_ID = "mode";

type SelectItem = Extract<ComposerControlItem, { type: "select" }>;

/**
 * Home: the Model row, then every control laid out in place: short choices as pills,
 * longer ones as a radio list, switches and actions as rows. Only a list too long to scan opens
 * a page of its own.
 */
export function AgentSheetHome({
  controls,
  disabled,
  topCard,
  footer,
  onOpenSelect,
}: {
  controls: AgentSheetControls;
  disabled: boolean;
  /** The Model row; null when the host hides the model picker. */
  topCard: ReactNode | null;
  /** Drawn after the controls, such as plugin items. */
  footer?: ReactNode;
  onOpenSelect: (controlId: string) => void;
}) {
  const { thinkingItems, featureItems, modeControl } = controls;
  const blocks = useMemo(
    () =>
      layoutSheetHome({
        thinkingItems,
        featureItems,
        modeChoiceCount: modeControl?.modeOptions.length ?? 0,
      }),
    [featureItems, modeControl?.modeOptions.length, thinkingItems],
  );
  return (
    <SheetScrollView
      style={styles.page}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={KEYBOARD_DISMISS_MODE}
      showsVerticalScrollIndicator={false}
      testID="agent-controls-settings-list"
    >
      {/* Themed insets sit on a View: the sheet scroller drops a themed contentContainerStyle on web. */}
      <View style={styles.content}>
        {topCard ? <View style={styles.block}>{topCard}</View> : null}
        {blocks.map((block) => (
          <HomeBlock
            key={blockKey(block)}
            block={block}
            modeControl={modeControl}
            disabled={disabled}
            onOpenSelect={onOpenSelect}
          />
        ))}
        {footer}
      </View>
    </SheetScrollView>
  );
}

function blockKey(block: SheetHomeBlock): string {
  switch (block.kind) {
    case "slider":
    case "pills":
    case "radioList":
      return `${block.kind}:${block.item.id}`;
    case "rows":
      return "rows";
    case "mode":
      return "mode";
  }
}

function HomeBlock({
  block,
  modeControl,
  disabled,
  onOpenSelect,
}: {
  block: SheetHomeBlock;
  modeControl: AgentModeControlValue | null;
  disabled: boolean;
  onOpenSelect: (controlId: string) => void;
}) {
  const { t } = useTranslation();
  const sectionLeading = useMemo(
    () =>
      block.kind === "pills" || block.kind === "radioList" ? (
        <ComposerControlIcon item={block.item} size={ICON_SIZE.sm} />
      ) : undefined,
    [block],
  );
  switch (block.kind) {
    case "slider":
      return (
        <View style={styles.block}>
          <SettingsCard>
            <SliderControl item={block.item} disabled={disabled} />
          </SettingsCard>
        </View>
      );
    case "pills":
      return (
        <SettingsSection
          title={block.item.title}
          leading={sectionLeading}
          flush
          style={styles.block}
          testID={block.item.testID ? `${block.item.testID}-section` : undefined}
        >
          <SettingsCard>
            <PillsControl item={block.item} disabled={disabled} />
          </SettingsCard>
        </SettingsSection>
      );
    case "radioList":
      return (
        <SettingsSection
          title={block.item.title}
          leading={sectionLeading}
          flush
          style={styles.block}
          testID={block.item.testID ? `${block.item.testID}-section` : undefined}
        >
          <SettingsCard testID={block.item.testID}>
            {block.item.choices.map((choice) => (
              <SelectChoiceRow
                key={choice.value}
                item={block.item}
                choice={choice}
                disabled={disabled}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      );
    case "rows":
      return (
        <View style={styles.block}>
          <SettingsCard>
            {block.rows.map((row) => (
              <ControlRow
                key={row.item.id}
                row={row}
                disabled={disabled}
                onOpenSelect={onOpenSelect}
              />
            ))}
          </SettingsCard>
        </View>
      );
    case "mode":
      if (!modeControl) return null;
      if (block.layout === "subpage") {
        return (
          <View style={styles.block}>
            <SettingsCard>
              <ModeSummaryRow modeControl={modeControl} onOpenSelect={onOpenSelect} />
            </SettingsCard>
          </View>
        );
      }
      return (
        <SettingsSection title={t("agentControls.mode.title")} flush style={styles.block}>
          <SettingsCard testID="mode-control">
            {modeControl.modeOptions.map((mode) => (
              <ModeRadioRow key={mode.id} mode={mode} modeControl={modeControl} />
            ))}
          </SettingsCard>
        </SettingsSection>
      );
  }
}

function SliderControl({ item, disabled }: { item: SelectItem; disabled: boolean }) {
  const { pending, run } = usePendingRun();
  const [previewValue, setPreviewValue] = useState<string | null>(null);
  const options = useMemo<SteppedSliderOption<string>[]>(
    () =>
      item.choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        testID: item.testID ? `${item.testID}-${choice.value}` : undefined,
      })),
    [item.choices, item.testID],
  );
  const handleChange = useCallback((value: string) => run(() => item.onChange(value)), [item, run]);
  const displayedValue = previewValue ?? item.value;
  const displayedLabel =
    item.choices.find((choice) => choice.value === displayedValue)?.label ??
    item.valueLabel ??
    item.title;

  return (
    <View style={styles.sliderCard}>
      <View style={styles.sliderHeader}>
        <View style={styles.sliderLeading}>
          <ComposerControlIcon item={item} size={ICON_SIZE.md} />
        </View>
        <Text style={styles.sliderTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.sliderValue} numberOfLines={1}>
          {displayedLabel}
        </Text>
      </View>
      <SteppedSlider
        options={options}
        value={item.value}
        onValueChange={handleChange}
        onPreviewChange={setPreviewValue}
        disabled={disabled || pending}
        accessibilityLabel={item.accessibilityLabel ?? item.title}
        testID={item.testID}
      />
    </View>
  );
}

function PillsControl({ item, disabled }: { item: SelectItem; disabled: boolean }) {
  const { pending, run } = usePendingRun();
  const options = useMemo<SegmentedControlOption<string>[]>(
    () =>
      item.choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        disabled: disabled || pending,
        testID: item.testID ? `${item.testID}-${choice.value}` : undefined,
      })),
    [disabled, item.choices, item.testID, pending],
  );
  const handleChange = useCallback((value: string) => run(() => item.onChange(value)), [item, run]);
  return (
    <View style={styles.pills}>
      <SegmentedControl
        options={options}
        value={item.value}
        onValueChange={handleChange}
        wrap
        testID={item.testID}
      />
    </View>
  );
}

function ControlRow({
  row,
  disabled,
  onOpenSelect,
}: {
  row: SheetHomeRow;
  disabled: boolean;
  onOpenSelect: (controlId: string) => void;
}) {
  const { item } = row;
  const { pending, run } = usePendingRun();
  const leading = useMemo(() => <ComposerControlIcon item={item} size={ICON_SIZE.md} />, [item]);
  const handleToggle = useCallback(
    (value: boolean) => {
      if (item.type === "toggle") run(() => item.onChange(value));
    },
    [item, run],
  );
  const handlePress = useCallback(() => {
    if (item.type === "action") run(item.onPress);
    else onOpenSelect(item.id);
  }, [item, onOpenSelect, run]);

  if (item.type === "toggle") {
    return (
      <SettingsSwitch
        label={item.title}
        leading={leading}
        value={item.value}
        onValueChange={handleToggle}
        disabled={disabled || pending}
        testID={item.testID}
      />
    );
  }
  return (
    <SettingsDetailRow
      label={item.title}
      leading={leading}
      summary={item.type === "select" ? selectValueLabel(item) : undefined}
      onPress={handlePress}
      disabled={disabled || pending}
      accessibilityLabel={item.accessibilityLabel}
      testID={item.testID}
    />
  );
}

function selectValueLabel(item: SelectItem): string {
  return (
    item.choices.find((choice) => choice.value === item.value)?.label ??
    item.valueLabel ??
    item.title
  );
}

/** One choice of a select, picked in place. */
export function SelectChoiceRow({
  item,
  choice,
  disabled,
  onPicked,
}: {
  item: SelectItem;
  choice: ComposerControlChoice;
  disabled: boolean;
  onPicked?: () => void;
}): ReactElement {
  const { pending, run } = usePendingRun();
  const option = useMemo<ComboboxOption>(
    () => ({
      id: choice.value,
      label: choice.label,
      description: choice.description,
    }),
    [choice],
  );
  const selected = option.id === (item.value ?? "");
  const handlePress = useCallback(() => {
    run(() => item.onChange(option.id));
    onPicked?.();
  }, [item, onPicked, option.id, run]);
  if (item.renderOption) {
    return item.renderOption({
      option,
      selected,
      active: false,
      onPress: handlePress,
    });
  }
  return (
    <SheetRadioRow
      label={option.label}
      hint={option.description}
      selected={selected}
      disabled={disabled || pending}
      onPress={handlePress}
      testID={item.testID ? `${item.testID}-${option.id}` : undefined}
    />
  );
}

function ModeSummaryRow({
  modeControl,
  onOpenSelect,
}: {
  modeControl: AgentModeControlValue;
  onOpenSelect: (controlId: string) => void;
}) {
  const { t } = useTranslation();
  const selected = findSelectedMode(modeControl);
  const Icon = selected
    ? getAgentModeOptionIcon(modeControl.provider, selected.id, modeControl.providerDefinitions)
    : undefined;
  const leading = useMemo(
    () => (Icon ? <Icon size={ICON_SIZE.md} color={styles.iconMuted.color} /> : undefined),
    [Icon],
  );
  const handlePress = useCallback(() => onOpenSelect(AGENT_SHEET_MODE_CONTROL_ID), [onOpenSelect]);
  return (
    <SettingsDetailRow
      label={t("agentControls.mode.title")}
      leading={leading}
      summary={selected ? formatAgentModeLabel(selected) : undefined}
      onPress={handlePress}
      disabled={modeControl.disabled}
      testID="mode-control"
    />
  );
}

function findSelectedMode(modeControl: AgentModeControlValue): AgentMode | null {
  return (
    modeControl.modeOptions.find((mode) => mode.id === modeControl.selectedModeId) ??
    modeControl.modeOptions[0] ??
    null
  );
}

/** A mode that runs tools without asking reads in the warning colour, so it is never picked by accident. */
function isUnattendedMode(
  mode: AgentMode,
  provider: string,
  providerDefinitions: AgentProviderDefinition[],
): boolean {
  const tier = getModeVisuals(provider, mode.id, providerDefinitions)?.colorTier ?? mode.colorTier;
  return tier === "dangerous";
}

/** One of the agent's modes, picked in place. */
export function ModeRadioRow({
  mode,
  modeControl,
  onPicked,
}: {
  mode: AgentMode;
  modeControl: AgentModeControlValue;
  onPicked?: () => void;
}) {
  const { provider, providerDefinitions, onSelectMode } = modeControl;
  const selected = findSelectedMode(modeControl)?.id === mode.id;
  const warning = isUnattendedMode(mode, provider, providerDefinitions);
  const Icon = getAgentModeOptionIcon(provider, mode.id, providerDefinitions);
  const leading = useMemo(
    () =>
      Icon ? (
        <Icon
          size={ICON_SIZE.md}
          color={warning ? styles.iconWarning.color : styles.iconMuted.color}
        />
      ) : undefined,
    [Icon, warning],
  );
  const handlePress = useCallback(() => {
    onSelectMode(mode.id);
    onPicked?.();
  }, [mode.id, onPicked, onSelectMode]);
  return (
    <SheetRadioRow
      label={formatAgentModeLabel(mode)}
      leading={leading}
      tone={warning ? "warning" : "default"}
      selected={selected}
      disabled={modeControl.disabled === true}
      onPress={handlePress}
      testID={`mode-option-${mode.id}`}
    />
  );
}

/** A row of a settings card that picks one of several values; the picked one carries a check. */
function SheetRadioRow({
  label,
  hint,
  leading,
  tone = "default",
  selected,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  hint?: string;
  leading?: ReactNode;
  tone?: "default" | "warning";
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const rowStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.radioRow,
      Boolean(hovered) && !disabled && styles.radioRowHovered,
      disabled && styles.radioRowDisabled,
    ],
    [disabled],
  );
  return (
    <PressHighlight
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      style={rowStyle}
      highlightStyle={styles.radioRowPressed}
      testID={testID}
    >
      {leading ? <View style={styles.radioLeading}>{leading}</View> : null}
      <View style={styles.radioLabel}>
        <Text
          style={[styles.radioTitle, tone === "warning" && styles.radioTitleWarning]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {hint ? (
          <Text style={styles.radioHint} numberOfLines={2}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View style={styles.checkSlot}>
        {selected ? (
          <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundIconColorMapping} />
        ) : null}
      </View>
    </PressHighlight>
  );
}

/** A page that lists one select's choices, or the agent's modes, for a list too long for Home. */
export function AgentSheetSelectPage({
  controlId,
  controls,
  query,
  disabled,
  onPicked,
}: {
  controlId: string;
  controls: AgentSheetControls;
  query: string;
  disabled: boolean;
  onPicked: () => void;
}) {
  const { modeControl } = controls;
  const item = useMemo(
    () =>
      [...controls.thinkingItems, ...controls.featureItems].find(
        (candidate): candidate is SelectItem =>
          candidate.id === controlId && candidate.type === "select",
      ) ?? null,
    [controlId, controls.featureItems, controls.thinkingItems],
  );
  const normalizedQuery = query.trim().toLowerCase();
  let rows: ReactNode = null;
  if (controlId === AGENT_SHEET_MODE_CONTROL_ID && modeControl) {
    rows = modeControl.modeOptions
      .filter((mode) => formatAgentModeLabel(mode).toLowerCase().includes(normalizedQuery))
      .map((mode) => (
        <ModeRadioRow key={mode.id} mode={mode} modeControl={modeControl} onPicked={onPicked} />
      ));
  } else if (item) {
    const choices =
      item.remoteSearch || !normalizedQuery
        ? item.choices
        : item.choices.filter((choice) => choice.label.toLowerCase().includes(normalizedQuery));
    rows = choices.map((choice) => (
      <SelectChoiceRow
        key={choice.value}
        item={item}
        choice={choice}
        disabled={disabled}
        onPicked={onPicked}
      />
    ));
  }
  const empty = !rows || (Array.isArray(rows) && rows.length === 0);
  return (
    <SheetScrollView
      style={styles.page}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={KEYBOARD_DISMISS_MODE}
      showsVerticalScrollIndicator={false}
      testID="agent-controls-select-page"
    >
      <View style={styles.content}>
        {empty ? (
          <Text style={styles.empty}>{item?.emptyText ?? ""}</Text>
        ) : (
          <SettingsCard>{rows}</SettingsCard>
        )}
      </View>
    </SheetScrollView>
  );
}

/** Whether a select page offers a search: the mode list and searchable selects do. */
export function selectPageIsSearchable(controlId: string, controls: AgentSheetControls): boolean {
  if (controlId === AGENT_SHEET_MODE_CONTROL_ID) return true;
  const item = [...controls.thinkingItems, ...controls.featureItems].find(
    (candidate) => candidate.id === controlId,
  );
  return item?.type === "select" && (item.searchable === true || item.remoteSearch === true);
}

/** The title of a select page. */
export function selectPageTitle(
  controlId: string,
  controls: AgentSheetControls,
  modeTitle: string,
): string {
  if (controlId === AGENT_SHEET_MODE_CONTROL_ID) return modeTitle;
  return (
    [...controls.thinkingItems, ...controls.featureItems].find(
      (candidate) => candidate.id === controlId,
    )?.title ?? ""
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[6],
  },
  block: {
    marginBottom: theme.spacing[4],
  },
  pills: {
    padding: theme.spacing[2],
  },
  sliderCard: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  sliderHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  sliderLeading: {
    marginRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  sliderTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  sliderValue: {
    marginLeft: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  radioRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  radioRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  radioRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  radioRowDisabled: {
    opacity: theme.opacity[50],
  },
  radioLeading: {
    marginRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  radioLabel: {
    flex: 1,
    minWidth: 0,
  },
  radioTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  radioTitleWarning: {
    color: theme.colors.statusWarning,
  },
  radioHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  checkSlot: {
    width: ICON_SIZE.sm,
    marginLeft: theme.spacing[3],
    alignItems: "center",
  },
  iconMuted: {
    color: theme.colors.foregroundMuted,
  },
  iconWarning: {
    color: theme.colors.statusWarning,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
}));
