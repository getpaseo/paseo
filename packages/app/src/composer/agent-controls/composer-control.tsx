import {
  createContext,
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
 * One control in the composer's toolbar, drawn from data. Provider option controls, thinking and
 * plugin controls all come through here, so each is an icon in the toolbar and a row in the sheet.
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
      onChange: (value: string) => void | Promise<void>;
      /** The toolbar trigger shows only the icon. */
      iconOnly?: boolean;
      showCaret?: boolean;
      searchable?: boolean;
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

export type ComposerControlSurface = "toolbar" | "sheet";

const ComposerControlSurfaceContext = createContext<ComposerControlSurface>("toolbar");
export const ComposerControlSurfaceProvider = ComposerControlSurfaceContext.Provider;

/** Where the control being drawn sits: the toolbar, or a row in the overflow sheet. */
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
    item.choices.find((choice) => choice.value === item.value)?.label ?? item.title;
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
    tooltip: item.tooltip ?? (iconOnly ? `${item.title}: ${choiceLabel}` : item.title),
    opensList: true,
  };
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
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: item.title }), [item.title]);
  const view = useMemo(() => describeControl(item, surface, t), [item, surface, t]);

  // A command that returns a promise keeps the control pending until it settles, and a failure
  // reaches the user the way a built-in live control's does.
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
  const trigger = (
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
      accessibilityLabel={item.accessibilityLabel ?? view.tooltip}
      testID={item.testID}
    />
  );

  return (
    <>
      {isSheet ? (
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
          desktopPlacement={isSheet ? undefined : "top-start"}
          desktopMinWidth={select?.desktopMinWidth}
          searchable={select ? select.searchable : false}
          renderOption={select?.renderOption}
          header={isSheet ? sheetHeader : undefined}
        />
      ) : null}
    </>
  );
}

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
  blue: { color: theme.colors.palette.blue[400] },
  green: { color: theme.colors.palette.green[400] },
  yellow: { color: theme.colors.palette.yellow[400] },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
