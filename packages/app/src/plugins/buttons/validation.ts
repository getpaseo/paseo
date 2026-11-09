import type { PluginText } from "@getpaseo/plugin/client";
import type {
  PluginButton as SDKPluginButton,
  PluginButtonBehavior as SDKPluginButtonBehavior,
  PluginButtonIcon,
} from "@getpaseo/plugin/client";

type PluginButton = SDKPluginButton<PluginText>;
type PluginButtonBehavior = SDKPluginButtonBehavior<PluginText>;

export interface ButtonValidation {
  /** Returns the normalized icon, or throws naming why the icon is unusable. */
  parseIcon(icon: PluginButtonIcon): PluginButtonIcon;
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

function requireText(
  value: PluginText,
  field: string,
  resolve: (text: PluginText) => string,
): string {
  value = resolve(value);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Plugin button needs ${field}`);
  return value.trim();
}

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function validateBehavior(
  behavior: PluginButtonBehavior,
  validation: ButtonValidation,
  resolve: (text: PluginText) => string,
): ResolvedPluginButtonBehavior {
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
          return {
            ...item,
            icon: item.icon === undefined ? undefined : validation.parseIcon(item.icon),
            title: requireText(item.title, "menu item title", resolve),
            visible: optionalBoolean(item.visible, true),
            disabled: optionalBoolean(item.disabled, false),
            behavior: validateBehavior(item.behavior, validation, resolve),
          };
        }),
      };
    }
    default:
      throw new Error("Invalid plugin button behavior");
  }
}

export type ResolvedPluginButtonBehavior =
  | Exclude<PluginButtonBehavior, { kind: "menu" }>
  | { kind: "menu"; items: readonly ResolvedPluginButtonMenuEntry[] };
export type ResolvedPluginButtonMenuEntry =
  | { kind: "separator"; id: string }
  | {
      kind: "item";
      id: string;
      title: string;
      icon?: PluginButtonIcon;
      visible?: boolean;
      disabled?: boolean;
      behavior: ResolvedPluginButtonBehavior;
    };
export type ResolvedPluginButton = Omit<PluginButton, "title" | "label" | "behavior"> & {
  title: string;
  visible: boolean;
  disabled: boolean;
  label: string | undefined;
  behavior: ResolvedPluginButtonBehavior;
};

export function validateButton(
  button: PluginButton,
  validation: ButtonValidation,
  resolve: (text: PluginText) => string,
): ResolvedPluginButton {
  return {
    ...button,
    icon: validation.parseIcon(button.icon),
    title: requireText(button.title, "title", resolve),
    label: button.label === undefined ? undefined : requireText(button.label, "label", resolve),
    visible: optionalBoolean(button.visible, true),
    disabled: optionalBoolean(button.disabled, false),
    behavior: validateBehavior(button.behavior, validation, resolve),
  };
}
