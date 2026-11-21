import { useId, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { DensityIcon } from "@/components/ui/density-icon";
import type { AgentOptionControl, ProviderOptions } from "@getpaseo/protocol/agent-types";
import { getAgentFeatureIcon, ThinkingIcon } from "@/agent-controls/icons";
import {
  getControlTooltip,
  isControlActive,
  readSelectOption,
  readToggleOption,
  type ComposerOptionControls,
} from "@/agent-controls/option-controls";
import { ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import {
  type ComposerControlItem,
  type ComposerControlSurface,
} from "@/composer/agent-controls/composer-control";
import type { ComposerControlPresentation } from "@/composer/agent-controls/layout";
import { getAgentControlHintKey, getFeatureHighlightColor } from "@/composer/agent-controls/utils";

import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useComposerInput } from "@/composer/session";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { resolveNextChoiceId } from "./mode";

const SEARCH_THRESHOLD = 6;

function getFeatureHighlight(
  control: AgentOptionControl,
  options: ProviderOptions,
): ComposerControlItem["highlight"] {
  if (!isControlActive(control, options)) return undefined;
  const color = getFeatureHighlightColor(control.key);
  return color === "default" ? undefined : color;
}

function toFeatureItem(
  control: AgentOptionControl,
  optionControls: ComposerOptionControls,
  surface: ComposerControlSurface,
  t: TFunction,
): ComposerControlItem {
  const { options, onSetOption } = optionControls;
  const base = {
    id: `feature-${control.key}`,
    title: control.label,
    icon: getAgentFeatureIcon(control.icon),
    highlight: getFeatureHighlight(control, options),
    testID: `agent-feature-${control.key}`,
  };
  if (control.type === "toggle") {
    const enabled = readToggleOption(control, options);
    const stateLabel = enabled ? t("agentControls.features.on") : t("agentControls.features.off");
    return {
      ...base,
      type: "toggle",
      tooltip:
        control.tooltip ??
        (surface === "toolbar" ? `${control.label}: ${stateLabel}` : control.label),
      value: enabled,
      onChange: (value) => onSetOption(control.key, value),
    };
  }
  const iconOnly = control.desktopTrigger === "icon";
  return {
    ...base,
    type: "select",
    tooltip: getControlTooltip(control),
    value: readSelectOption(control, options),
    choices: control.choices,
    iconOnly,
    onChange: (value) => onSetOption(control.key, value),
  };
}

interface ThinkingControl {
  options: readonly { id: string; label: string }[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** The select's displayed label, falling back like the compact model sheet. */
  displayLabel: string;
}

export function useModelPickerShortcut(disabled: boolean) {
  const { isActiveComposer } = useComposerKeyboardScope();
  const input = useComposerInput();
  const action =
    isActiveComposer && !disabled && input
      ? {
          id: "message-input.model-toggle" as const,
          canOpen: input.isFocused,
        }
      : undefined;
  const keys = useShortcutKeys(action ? "toggle-model-picker" : null);
  return { action, keys };
}

export function useEffortCycleShortcut(thinking: ThinkingControl | null, disabled: boolean) {
  const { isActiveComposer } = useComposerKeyboardScope();
  const input = useComposerInput();
  const effortHandlerId = useId();
  const nextEffortId = resolveNextChoiceId(thinking?.options ?? [], thinking?.selectedId);
  const canCycleEffort = isActiveComposer && !disabled && nextEffortId !== null && input !== null;
  useKeyboardActionHandler({
    handlerId: effortHandlerId,
    actions: ["message-input.effort-cycle"],
    enabled: canCycleEffort,
    isActive: input?.isFocused,
    priority: 200,
    handle: () => {
      if (!thinking || nextEffortId === null) return false;
      thinking.onSelect(nextEffortId);
      return true;
    },
  });
  return useShortcutKeys(canCycleEffort ? "cycle-effort" : null);
}

/** The thinking select and the option controls, as the data `ComposerControl` draws. */
export function useAgentControlItems({
  surface,
  presentation,
  thinking,
  optionControls,
}: {
  surface: ComposerControlSurface;
  presentation: ComposerControlPresentation;
  thinking: ThinkingControl | null;
  optionControls: ComposerOptionControls | undefined;
}): { thinking: ComposerControlItem[]; features: ComposerControlItem[] } {
  const { t } = useTranslation();

  const thinkingItem = useMemo(
    () => (thinking ? [toThinkingItem({ thinking, surface, presentation, t })] : []),
    [presentation, surface, t, thinking],
  );
  const features = useMemo(
    () =>
      optionControls
        ? optionControls.controls.map((control) =>
            toFeatureItem(control, optionControls, surface, t),
          )
        : [],
    [optionControls, surface, t],
  );
  return { thinking: thinkingItem, features };
}

function toThinkingItem({
  thinking,
  surface,
  presentation,
  t,
}: {
  thinking: ThinkingControl;
  surface: ComposerControlSurface;
  presentation: ComposerControlPresentation;
  t: TFunction;
}): ComposerControlItem {
  const isSheet = surface === "sheet";
  return {
    id: "thinking",
    type: "select",
    title: t("agentControls.thinking.title"),
    icon: ThinkingIcon,
    tooltip: t(getAgentControlHintKey("thinking")),
    accessibilityLabel: t("agentControls.thinking.selectWithValue", {
      value: thinking.displayLabel,
    }),
    testID: isSheet ? "agent-controls-thinking" : "agent-thinking-selector",
    value: thinking.options.some((option) => option.id === thinking.selectedId)
      ? (thinking.selectedId ?? null)
      : (thinking.options[0]?.id ?? null),
    choices: thinking.options.map((option) => ({ value: option.id, label: option.label })),
    onChange: thinking.onSelect,
    iconOnly: !presentation.showThinkingLabel,
    showCaret: presentation.showCarets,
    searchable: !isSheet && thinking.options.length > SEARCH_THRESHOLD,
    desktopMinWidth: 200,
    renderOption: (args) => <ThinkingOption {...args} />,
  };
}

function ThinkingOption({
  option,
  selected,
  active,
  onPress,
}: {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}) {
  const leadingSlot = useMemo(
    () => <DensityIcon icon={ThinkingIcon} size="md" color="foreground" />,
    [],
  );
  return (
    <ComboboxItem
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}
