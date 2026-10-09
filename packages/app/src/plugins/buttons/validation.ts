import type { PluginButton, PluginButtonBehavior, PluginButtonIcon } from "@getpaseo/plugin/client";

export interface ButtonValidation {
  validateIconName(name: string): void;
}

export function requireButtonId(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value))
    throw new Error(`Invalid plugin button id: ${value}`);
  return value;
}

function optionalBoolean(value: boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error("Plugin button visibility and disabled state must be booleans");
  return value;
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Plugin button needs ${field}`);
  return value.trim();
}

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function validateIcon(icon: PluginButtonIcon, validation: ButtonValidation): void {
  if (typeof icon === "string") validation.validateIconName(icon);
  else if (!isComponent(icon))
    throw new Error("Plugin button icon must be a Lucide name or component");
}

function validateBehavior(
  behavior: PluginButtonBehavior,
  validation: ButtonValidation,
): PluginButtonBehavior {
  switch (behavior.kind) {
    case "action":
      if (typeof behavior.onPress !== "function")
        throw new Error("Plugin button action needs onPress");
      return { ...behavior };
    case "popover":
      if (!isComponent(behavior.Content)) throw new Error("Plugin button popover needs Content");
      return { ...behavior };
    case "menu": {
      const ids = new Set<string>();
      return {
        kind: "menu",
        items: behavior.items.map((item) => {
          requireButtonId(item.id);
          if (ids.has(item.id)) throw new Error(`Duplicate plugin button menu item: ${item.id}`);
          ids.add(item.id);
          if (item.kind === "separator") return { ...item };
          if (item.kind !== "item") throw new Error("Invalid plugin button menu entry");
          if (item.icon !== undefined) validateIcon(item.icon, validation);
          return {
            ...item,
            title: requireText(item.title, "menu item title"),
            visible: optionalBoolean(item.visible, true),
            disabled: optionalBoolean(item.disabled, false),
            behavior: validateBehavior(item.behavior, validation),
          };
        }),
      };
    }
    default:
      throw new Error("Invalid plugin button behavior");
  }
}

export type ResolvedPluginButton = PluginButton & {
  visible: boolean;
  disabled: boolean;
  label: string | undefined;
};

export function validateButton(
  button: PluginButton,
  validation: ButtonValidation,
): ResolvedPluginButton {
  validateIcon(button.icon, validation);
  return {
    ...button,
    title: requireText(button.title, "title"),
    label: button.label === undefined ? undefined : requireText(button.label, "label"),
    visible: optionalBoolean(button.visible, true),
    disabled: optionalBoolean(button.disabled, false),
    behavior: validateBehavior(button.behavior, validation),
  };
}
