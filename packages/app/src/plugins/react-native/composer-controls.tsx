import type { ActionProps, SelectProps, ToggleProps } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import {
  ComposerControl,
  useComposerControlSurface,
  type ComposerControlItem,
} from "@/composer/agent-controls/composer-control";
import { parsePluginIcon, pluginIconComponent } from "../icons";

/** Icons resolve at render, so an invalid one throws to the item's boundary. */
function usePluginControlIcon(icon: ToggleProps["icon"]) {
  return useMemo(() => pluginIconComponent(parsePluginIcon("Composer control", icon)), [icon]);
}

/** Draws one plugin control where its composer item sits: inline, or as a row in the sheet. */
function PluginComposerControl({
  item,
  disabled,
}: {
  item: ComposerControlItem;
  disabled: boolean | undefined;
}) {
  const surface = useComposerControlSurface();
  const [open, setOpen] = useState(false);
  return (
    <ComposerControl
      item={item}
      surface={surface}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

export function Toggle({ title, icon, disabled, value, onValueChange }: ToggleProps) {
  const Icon = usePluginControlIcon(icon);
  const item = useMemo<ComposerControlItem>(
    () => ({
      id: "plugin-toggle",
      type: "toggle",
      title,
      icon: Icon,
      highlight: value ? "blue" : undefined,
      value,
      onChange: onValueChange,
    }),
    [Icon, onValueChange, title, value],
  );
  return <PluginComposerControl item={item} disabled={disabled} />;
}

export function Select<Value extends string>({
  title,
  icon,
  disabled,
  value,
  options,
  onValueChange,
}: SelectProps<Value>) {
  const Icon = usePluginControlIcon(icon);
  const item = useMemo<ComposerControlItem>(
    () => ({
      id: "plugin-select",
      type: "select",
      title,
      icon: Icon,
      value,
      choices: options,
      onChange: (next) => onValueChange(next as Value),
      showCaret: true,
    }),
    [Icon, onValueChange, options, title, value],
  );
  return <PluginComposerControl item={item} disabled={disabled} />;
}

export function Action({ title, icon, disabled, onPress }: ActionProps) {
  const Icon = usePluginControlIcon(icon);
  const item = useMemo<ComposerControlItem>(
    () => ({ id: "plugin-action", type: "action", title, icon: Icon, onPress }),
    [Icon, onPress, title],
  );
  return <PluginComposerControl item={item} disabled={disabled} />;
}
