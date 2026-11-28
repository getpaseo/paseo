import type {
  AssistantFileLinkInspection,
  AssistantFileLinkPath,
  AssistantFileLinkSource,
} from "@/assistant-file-links";

export interface Point {
  x: number;
  y: number;
}

export interface LinkMenuLink {
  url: string;
  sourceType?: "markdown" | "text" | "inline-code";
}

export interface LinkMenuWorkspace {
  serverId: string;
  workspaceId?: string;
  workspaceRoot: string;
}

type PathInspection = Extract<AssistantFileLinkInspection, { kind: "path" }>;

/** What a link in Markdown leads to. */
export type LinkMenuSubject =
  | { kind: "web"; url: string; workspace: LinkMenuWorkspace | null }
  | {
      kind: "path";
      source: AssistantFileLinkSource;
      inspection: PathInspection;
      workspace: LinkMenuWorkspace;
    };

export type OpenedLink =
  | Extract<LinkMenuSubject, { kind: "web" }>
  | (Extract<LinkMenuSubject, { kind: "path" }> & {
      lookup: Promise<AssistantFileLinkPath | null>;
      /** Null while the host is being asked, and when nothing matches. */
      found: AssistantFileLinkPath | null;
    });
