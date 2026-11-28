import type { ModelPickerListItem } from "@/components/model-browser-panes-view";
import {
  filterAndRankProfileRows,
  MODEL_BROWSER_CREATE_PROFILE_KEY,
  modelBrowserProfileKey,
  type NavigableProfileRow,
} from "@/components/model-browser-view";

/**
 * The pages of the compact agent settings sheet. One sheet swaps its page in place; nothing stacks
 * a second sheet over it.
 */
export type AgentSheetPage =
  | { kind: "home" }
  | { kind: "model" }
  | { kind: "profiles" }
  /** A select too long to scan on home, by control id; `mode` is the agent's mode. */
  | { kind: "select"; controlId: string };

export const AGENT_SHEET_HOME: AgentSheetPage = { kind: "home" };

export type AgentSheetEscape = "clearQuery" | "home" | "close";

/** Escape undoes one step: the search, then the page, then the sheet. */
export function resolveAgentSheetEscape(input: {
  page: AgentSheetPage;
  query: string;
}): AgentSheetEscape {
  if (input.page.kind === "home") return "close";
  return input.query.trim().length > 0 ? "clearQuery" : "home";
}

export type AgentSheetProfilesView<TProfile extends NavigableProfileRow> =
  | { kind: "list"; items: ModelPickerListItem<TProfile>[] }
  /** No profiles yet, and this surface cannot create one. */
  | { kind: "empty" }
  | { kind: "noMatches"; query: string };

/** The Profiles page: the saved profiles, best match first, or the way to create the first one. */
export function projectAgentSheetProfiles<TProfile extends NavigableProfileRow>(input: {
  profiles: readonly TProfile[];
  query: string;
  canCreate: boolean;
}): AgentSheetProfilesView<TProfile> {
  const query = input.query.trim();
  if (input.profiles.length === 0 && !query) {
    return input.canCreate
      ? { kind: "list", items: [{ kind: "createProfile", key: MODEL_BROWSER_CREATE_PROFILE_KEY }] }
      : { kind: "empty" };
  }
  const matches = filterAndRankProfileRows(input.profiles, query.toLowerCase());
  if (matches.length === 0) return { kind: "noMatches", query };
  return {
    kind: "list",
    items: matches.map((profile) => ({
      kind: "profile",
      key: modelBrowserProfileKey(profile.id),
      profile,
    })),
  };
}
