import type { ComponentType } from "react";
import type { ShortcutKey } from "@/utils/format-shortcut";

export interface CommandCenterIconProps {
  size: number;
}

export type CommandCenterIcon = ComponentType<CommandCenterIconProps>;

interface CommandCenterContributionBase {
  id: string;
  group: string;
  groupRank: number;
  rank: number;
  keywords: readonly string[];
  visibility: "always" | "query";
  run(): void | Promise<void>;
}

export type CommandCenterContribution =
  | (CommandCenterContributionBase & {
      presentation: {
        kind: "action";
        title: string;
        subtitle?: string;
        sectionTitle?: string;
        icon?: CommandCenterIcon;
        shortcutKeys?: ShortcutKey[][];
      };
    })
  | (CommandCenterContributionBase & {
      presentation: {
        kind: "choice";
        path: readonly [string, ...string[]];
        icon?: CommandCenterIcon;
        selected: boolean;
        testId?: string;
      };
    });

export interface CommandCenterContributionSnapshot {
  contributions: readonly CommandCenterContribution[];
}

export interface CommandCenterRegistrationOwner {
  sourceId: string;
  token: symbol;
}

export interface CommandCenterRegistration {
  owner: CommandCenterRegistrationOwner;
  contributions: readonly CommandCenterContribution[];
}
