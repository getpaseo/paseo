import type { ComponentType } from "react";
import type { PluginNavigableHostProps } from "./contracts.js";

export type PluginButtonContext =
  | { context: "workspace"; workspaceId: string }
  | { context: "agent"; workspaceId: string; agentId: string };

export type PluginButtonIconProps = PluginNavigableHostProps &
  PluginButtonContext & { size: number; color: string };

export type PluginButtonContentProps = PluginNavigableHostProps &
  PluginButtonContext & { close(): void };

export type PluginButtonIcon = string | ComponentType<PluginButtonIconProps>;

export type PluginButtonBehavior =
  | { kind: "action"; onPress(): void | Promise<void> }
  | { kind: "menu"; items: readonly PluginButtonMenuEntry[] }
  | {
      kind: "popover";
      Content: ComponentType<PluginButtonContentProps>;
      /**
       * `false` drops the title row the phone sheet otherwise shows above `Content`. Hosts that do
       * not support it keep the title.
       */
      sheetTitle?: false;
      /** Popover width in points on wide layouts. Phones always use a full-width sheet. */
      width?: number;
    };

export type PluginButtonMenuEntry =
  | { kind: "separator"; id: string }
  | {
      kind: "item";
      id: string;
      title: string;
      icon?: PluginButtonIcon;
      visible?: boolean;
      disabled?: boolean;
      behavior: PluginButtonBehavior;
    };

export interface PluginButton {
  title: string;
  icon: PluginButtonIcon;
  /** Omit for an icon-only header button. Composer pills use title when omitted. */
  label?: string;
  visible?: boolean;
  disabled?: boolean;
  behavior: PluginButtonBehavior;
}

export interface PluginButtonRegistration {
  /** Updates presentation in place. Supply a complete behavior to replace it. */
  update(patch: Partial<PluginButton>): void;
  /** Idempotent. Updates after removal do nothing. */
  remove(): void;
}

export interface PluginHeaderButtonContribution {
  id: string;
  workspaceId: string;
  button: PluginButton;
}

export interface PluginComposerPillContribution extends PluginHeaderButtonContribution {
  agentId: string;
}
