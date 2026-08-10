/**
 * What the line under a workspace title says for identity, depending on grouping.
 *
 * Project grouping always means "host" when identity is on (the project is already the
 * section header). Status grouping can show the host or the project name.
 */

export const SIDEBAR_STATUS_SUBTITLES = ["host", "project"] as const;

export type SidebarStatusSubtitle = (typeof SIDEBAR_STATUS_SUBTITLES)[number];

export const DEFAULT_SIDEBAR_STATUS_SUBTITLE: SidebarStatusSubtitle = "host";

export function isSidebarStatusSubtitle(value: unknown): value is SidebarStatusSubtitle {
  return (
    typeof value === "string" && (SIDEBAR_STATUS_SUBTITLES as readonly string[]).includes(value)
  );
}

export function parseSidebarStatusSubtitle(value: unknown): SidebarStatusSubtitle {
  return isSidebarStatusSubtitle(value) ? value : DEFAULT_SIDEBAR_STATUS_SUBTITLE;
}
