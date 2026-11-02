import type { PluginText } from "../text.js";
import type { ComponentType } from "react";
import type { PluginIconProps } from "../icons.js";
import type { PluginHostProps, PluginIcon } from "./contracts.js";

export type PluginButtonContext =
  | { context: "workspace"; workspaceId: string }
  | { context: "agent"; workspaceId: string; agentId: string };

export type PluginButtonIconProps = PluginHostProps & PluginButtonContext & PluginIconProps;

export type PluginButtonContentProps = PluginHostProps & PluginButtonContext & { close(): void };

export type PluginButtonIcon = PluginIcon<PluginButtonIconProps>;

export type PluginButtonBehavior<Text extends PluginText = string> =
  | { kind: "action"; onPress(): void | Promise<void> }
  | { kind: "menu"; items: readonly PluginButtonMenuEntry<Text>[] }
  | { kind: "popover"; Content: ComponentType<PluginButtonContentProps> };
export type PluginButtonMenuEntry<Text extends PluginText = string> =
  | { kind: "separator"; id: string }
  | {
      kind: "item";
      id: string;
      title: Text;
      icon?: PluginButtonIcon;
      visible?: boolean;
      disabled?: boolean;
      behavior: PluginButtonBehavior<Text>;
    };

export interface PluginButton<Text extends PluginText = string> {
  title: Text;
  icon: PluginButtonIcon;
  /** Omit for an icon-only header button. Composer pills use title when omitted. */
  label?: Text;
  visible?: boolean;
  disabled?: boolean;
  behavior: PluginButtonBehavior<Text>;
}
export interface PluginButtonRegistration<Text extends PluginText = string> {
  /** Updates presentation in place. Supply a complete behavior to replace it. */
  update(patch: Partial<PluginButton<Text>>): void;
  /** Idempotent. Updates after removal do nothing. */
  remove(): void;
}
export interface PluginHeaderButtonContribution<Text extends PluginText = string> {
  id: string;
  workspaceId: string;
  button: PluginButton<Text>;
}
export interface PluginComposerPillContribution<
  Text extends PluginText = string,
> extends PluginHeaderButtonContribution<Text> {
  agentId: string;
}
