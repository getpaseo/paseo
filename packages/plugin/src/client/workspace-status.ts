import type { ComponentType } from "react";
import type { WorkspaceStateBucket, WorkspaceStatusDetails } from "@getpaseo/protocol/messages";
import type { PluginWorkspaceActivitySnapshot } from "../contracts.js";
import type { PluginHostProps } from "./contracts.js";

export type PluginWorkspaceStatusDetails = Readonly<
  Omit<WorkspaceStatusDetails, "roots" | "subordinates">
> & {
  readonly roots: readonly Readonly<WorkspaceStatusDetails["roots"][number]>[];
  readonly subordinates: readonly Readonly<WorkspaceStatusDetails["subordinates"][number]>[];
};

export type PluginWorkspaceStatusActivity = PluginWorkspaceActivitySnapshot;

/** A passive replacement for one workspace row's status mark, owned by that host. */
export interface PluginWorkspaceStatusRendererProps extends PluginHostProps {
  workspace: Readonly<{
    id: string;
    name: string;
    /** The authoritative aggregate, including plugin activities. */
    status: WorkspaceStateBucket;
  }>;
  /** Null means the host does not supply this inventory, never zero active children. */
  statusDetails: PluginWorkspaceStatusDetails | null;
  /** Null means activity reporting is unavailable. One record may represent `count` tasks. */
  activities: readonly PluginWorkspaceStatusActivity[] | null;
  primaryActivityId: string | null;
  /** The bounded square drawing area in logical pixels. */
  size: number;
  loading: boolean;
}

export interface PluginWorkspaceStatusRendererContribution {
  id: string;
  Component: ComponentType<PluginWorkspaceStatusRendererProps>;
}
