import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentControlIcon } from "@/agent-controls/icons";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { useIsCompactFormFactor } from "@/constants/layout";
import { FieldTrigger } from "@/screens/new-workspace/form/field-trigger";
import { ICON_SIZE } from "@/styles/theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useToast } from "@/contexts/toast-api-context";
import { toErrorMessage } from "@/utils/error-messages";

interface ComposerControlBase {
  id: string;
  title: string;
  icon: AgentControlIcon;
  /** Tints the icon; muted when absent. */
  highlight?: "blue" | "green" | "yellow";
  /** Defaults to the title, or to "title: choice" on an icon-only select. */
  tooltip?: string;
  /** Defaults to the tooltip. */
  accessibilityLabel?: string;
  testID?: string;
}

export interface ComposerControlChoice {
  value: string;
  label: string;
  description?: string;
}

/**
 * One control, drawn from data. Provider option controls, thinking and plugin controls all come
 * through here, so each is an icon in the composer toolbar, a row in its sheet, or, in a New
 * workspace item, a field. The name stays from when the composer was the only place it drew.
 */
export type ComposerControlItem =
  | (ComposerControlBase & {
      type: "toggle";
      value: boolean;
      onChange: (value: boolean) => void | Promise<void>;
    })
  | (ComposerControlBase & {
      type: "select";
      value: string | null;
      choices: readonly ComposerControlChoice[];
      /** Names a value the choices do not list, such as a pick that a search no longer returns. */
      valueLabel?: string;
      onChange: (value: string) => void | Promise<void>;
      /** The toolbar trigger shows only the icon. */
      iconOnly?: boolean;
      showCaret?: boolean;
      searchable?: boolean;
      /** The list answers `onSearchQueryChange` itself, so it is not filtered again. */
      remoteSearch?: boolean;
      onSearchQueryChange?: (query: string) => void;
      emptyText?: string;
      desktopMinWidth?: number;
      renderOption?: (args: {
        option: ComboboxOption;
        selected: boolean;
        active: boolean;
        onPress: () => void;
      }) => ReactElement;
    })
  | (ComposerControlBase & {
      type: "action";
      onPress: () => void | Promise<void>;
    });

/** `field`: a New workspace setup field, a badge on desktop and a full-width field when compact. */
export type ComposerControlSurface = "toolbar" | "sheet" | "field";

const ComposerControlSurfaceContext = createContext<ComposerControlSurface>("toolbar");
export const ComposerControlSurfaceProvider = ComposerControlSurfaceContext.Provider;

const ComposerControlLockContext = createContext(false);
/** Disables every control below it, for a surface that is not a composer and has its own lock. */
export const ComposerControlLockProvider = ComposerControlLockContext.Provider;

export function useComposerControlLocked(): boolean {
  return useContext(ComposerControlLockContext);
}

/** Where the control being drawn sits: the toolbar, a row in the overflow sheet, or a field. */
export function useComposerControlSurface(): ComposerControlSurface {
  return useContext(ComposerControlSurfaceContext);
}

interface ComposerControlProps {
  item: ComposerControlItem;
  surface: ComposerControlSurface;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs after a toolbar toggle or action, so the composer can take focus back. */
  onActionComplete?: () => void;
}

interface ControlView {
  options: ComboboxOption[];
  /** The list's selected id. */
  selectedId: string;
  /** What the trigger shows beside the icon. */
  value: string;
  iconOnly: boolean;
  tooltip: string;
  /** Whether pressing the trigger opens a list instead of acting. */
  opensList: boolean;
}

function describeControl(
  item: ComposerControlItem,
  surface: ComposerControlSurface,
  t: TFunction,
): ControlView {
  const isSheet = surface === "sheet";
  if (item.type === "action") {
    return {
      options: [],
      selectedId: "",
      value: "",
      iconOnly: true,
      tooltip: item.tooltip ?? item.title,
      opensList: false,
    };
  }
  if (item.type === "toggle") {
    const label = item.value ? t("agentControls.features.on") : t("agentControls.features.off");
    return {
      options: [
        { id: "true", label: t("agentControls.features.on") },
        { id: "false", label: t("agentControls.features.off") },
      ],
      selectedId: String(item.value),
      value: label,
      iconOnly: true,
      tooltip: item.tooltip ?? item.title,
      opensList: isSheet,
    };
  }
  const choiceLabel =
    item.choices.find((choice) => choice.value === item.value)?.label ??
    item.valueLabel ??
    item.title;
  const iconOnly = item.iconOnly === true;
  return {
    options: item.choices.map((choice) => ({
      id: choice.value,
      label: choice.label,
      description: choice.description,
    })),
    selectedId: String(item.value ?? ""),
    value: choiceLabel,
    iconOnly,
    // An icon-only trigger names its value; a sheet row shows the value, so it names the action.
    tooltip: iconOnly && !isSheet ? `${item.title}: ${choiceLabel}` : (item.tooltip ?? item.title),
    opensList: true,
  };
}

type SelectItem = Extract<ComposerControlItem, { type: "select" }>;

/** The list options only a select carries; a toggle's two-choice list has none of them. */
function listProps(select: SelectItem | null) {
  if (!select) return { searchable: false };
  return {
    desktopMinWidth: select.desktopMinWidth,
    searchable: select.searchable,
    remoteSearch: select.remoteSearch,
    onSearchQueryChange: select.onSearchQueryChange,
    emptyText: select.emptyText,
    renderOption: select.renderOption,
  };
}

// A command that returns a promise keeps the control pending until it settles, and a failure
// reaches the user the way a built-in live control's does.
function usePendingRun() {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = useCallback(
    (invoke: () => void | Promise<void>) => {
      try {
        const result = invoke();
        if (!result) return;
        setPending(true);
        result
          .catch((error: unknown) => toast.error(toErrorMessage(error)))
          .finally(() => setPending(false));
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [toast],
  );
  return { pending, run };
}

export function ComposerControl({
  item,
  surface,
  disabled = false,
  open,
  onOpenChange,
  onActionComplete,
}: ComposerControlProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const isSheet = surface === "sheet";
  const isField = surface === "field";
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: item.title }), [item.title]);
  const view = useMemo(() => describeControl(item, surface, t), [item, surface, t]);

  const { pending, run } = usePendingRun();
  const handlePress = useCallback(() => {
    if (item.type === "toggle") run(() => item.onChange(!item.value));
    else if (item.type === "action") run(item.onPress);
    onActionComplete?.();
  }, [item, onActionComplete, run]);
  const handleOpenPress = useCallback(() => onOpenChange(!open), [onOpenChange, open]);
  const handleSelect = useCallback(
    (value: string) => {
      if (item.type === "select") run(() => item.onChange(value));
      else if (item.type === "toggle") run(() => item.onChange(value === "true"));
    },
    [item, run],
  );

  const select = item.type === "select" ? item : null;
  const accessibilityLabel = item.accessibilityLabel ?? view.tooltip;
  const trigger = isField ? (
    <FieldControlTrigger
      ref={anchorRef}
      item={item}
      view={view}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled || pending}
      onPress={view.opensList ? handleOpenPress : handlePress}
    />
  ) : (
    <AgentControlTrigger
      ref={anchorRef}
      icon={item.icon}
      iconColor={item.highlight ? styles[item.highlight].color : undefined}
      surface={surface}
      label={item.title}
      value={view.value}
      showToolbarLabel={!view.iconOnly}
      showCaret={select?.showCaret === true && !isSheet}
      open={view.opensList && open}
      disabled={disabled || pending}
      onPress={view.opensList ? handleOpenPress : handlePress}
      accessibilityLabel={accessibilityLabel}
      testID={item.testID}
    />
  );

  return (
    <>
      {isSheet || isField ? (
        trigger
      ) : (
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="ref">
            {trigger}
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{view.tooltip}</Text>
          </TooltipContent>
        </Tooltip>
      )}
      {view.opensList ? (
        <Combobox
          options={view.options}
          value={view.selectedId}
          onSelect={handleSelect}
          open={open}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          presentation={isSheet ? "push" : undefined}
          desktopPlacement={DESKTOP_PLACEMENT[surface]}
          {...listProps(select)}
          header={isSheet ? sheetHeader : undefined}
        />
      ) : null}
    </>
  );
}

/** Where a list opens on desktop; the sheet has its own presentation. */
const DESKTOP_PLACEMENT = {
  toolbar: "top-start",
  sheet: undefined,
  field: "bottom-start",
} as const;

/** What a field shows: a badge has no label, so a toggle names itself beside its state. */
function fieldValue(item: ComposerControlItem, view: ControlView, compact: boolean): string {
  if (item.type === "action") return item.title;
  if (item.type === "toggle" && !compact) return `${item.title}: ${view.value}`;
  return view.value;
}

const FieldControlTrigger = forwardRef<
  View,
  {
    item: ComposerControlItem;
    view: ControlView;
    accessibilityLabel: string;
    disabled: boolean;
    onPress: () => void;
  }
>(function FieldControlTrigger({ item, view, accessibilityLabel, disabled, onPress }, ref) {
  const compact = useIsCompactFormFactor();
  const Icon = item.icon;
  const iconColor = item.highlight ? styles[item.highlight].color : styles.fieldIcon.color;
  const icon = useMemo(() => <Icon size={ICON_SIZE.sm} color={iconColor} />, [Icon, iconColor]);
  return (
    <FieldTrigger
      ref={ref}
      variant={compact ? "field" : "badge"}
      label={item.title}
      icon={icon}
      value={fieldValue(item, view, compact)}
      tooltip={view.tooltip}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      testID={item.testID}
    />
  );
});

interface ComposerControlsProps {
  items: readonly ComposerControlItem[];
  surface: ComposerControlSurface;
  disabled?: boolean;
  /** The id of the item whose list is open. */
  openId: string | null;
  onOpenIdChange: (id: string | null) => void;
  onActionComplete?: () => void;
}

/** A row of Paseo-owned controls that share one open list at a time. */
export function ComposerControls({
  items,
  onOpenIdChange,
  openId,
  ...rest
}: ComposerControlsProps) {
  return (
    <>
      {items.map((item) => (
        <ComposerControlSlot
          key={item.id}
          item={item}
          open={openId === item.id}
          onOpenIdChange={onOpenIdChange}
          {...rest}
        />
      ))}
    </>
  );
}

function ComposerControlSlot({
  item,
  open,
  onOpenIdChange,
  ...rest
}: Omit<ComposerControlsProps, "items" | "openId"> & { item: ComposerControlItem; open: boolean }) {
  const handleOpenChange = useCallback(
    (next: boolean) => onOpenIdChange(next ? item.id : null),
    [item.id, onOpenIdChange],
  );
  return <ComposerControl item={item} open={open} onOpenChange={handleOpenChange} {...rest} />;
}

const styles = StyleSheet.create((theme) => ({
  fieldIcon: { color: theme.colors.foregroundMuted },
  blue: { color: theme.colors.palette.blue[400] },
  green: { color: theme.colors.palette.green[400] },
  yellow: { color: theme.colors.palette.yellow[400] },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
