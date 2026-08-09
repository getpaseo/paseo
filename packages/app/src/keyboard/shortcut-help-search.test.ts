import { describe, expect, it } from "vitest";
import {
  buildEffectiveBindings,
  buildKeyboardShortcutHelpSections,
  UNASSIGNED_COMBO,
  type ShortcutOverrides,
} from "./keyboard-shortcuts";
import { filterShortcutHelpSections, shortcutSearchText } from "./shortcut-help-search";

const MAC_DESKTOP = { isMac: true, isDesktop: true };
const NEW_WORKSPACE_BINDING = "workspace-new-cmd-n-mac";

/**
 * The i18n port, filled with the real English strings the rows use. Translation
 * is the only dependency the filter cannot compute, so it is injected rather
 * than mocked.
 */
const EN: Record<string, string> = {
  "settings.shortcuts.sections.projects": "Projects",
  "settings.shortcuts.help.newWorkspace": "New workspace",
  "settings.shortcuts.help.openProject": "Open project",
};

function translate(key: string): string {
  return EN[key] ?? key;
}

function filter(query: string, overrides: ShortcutOverrides = {}) {
  return filterShortcutHelpSections({
    sections: buildKeyboardShortcutHelpSections(MAC_DESKTOP, buildEffectiveBindings(overrides)),
    query,
    translate,
    shortcutOs: "mac",
  });
}

function matchedRowIds(query: string, overrides: ShortcutOverrides = {}): string[] {
  return filter(query, overrides).flatMap((section) => section.rows.map((row) => row.id));
}

describe("shortcutSearchText", () => {
  it("covers the tokens, the rendered badge, and the modifier aliases", () => {
    const text = shortcutSearchText([["mod", "N"]], "mac");

    expect(text).toContain("mod N");
    expect(text).toContain("⌘N");
    expect(text).toContain("cmd+N");
    expect(text).toContain("command+N");
  });

  // The alias expansion is combinatorial, so a flattened chord would multiply
  // the two combos together and invent spellings for keys never pressed at once.
  it("keeps a multi-step chord's combos apart", () => {
    const text = shortcutSearchText(
      [
        ["mod", "K"],
        ["mod", "N"],
      ],
      "mac",
    );

    expect(text).toContain("cmd+K");
    expect(text).toContain("cmd+N");
    expect(text).not.toContain("cmd+K+cmd+N");
  });
});

describe("filterShortcutHelpSections", () => {
  it("returns every section for a blank query", () => {
    expect(filter("  ")).toHaveLength(buildKeyboardShortcutHelpSections(MAC_DESKTOP).length);
  });

  it("matches a row by its label", () => {
    expect(matchedRowIds("new workspace")).toContain("new-workspace");
  });

  it("matches a row by the rendered badge", () => {
    expect(matchedRowIds("⌘n")).toContain("new-workspace");
  });

  it("matches a row by a spelled-out modifier", () => {
    expect(matchedRowIds("command+n")).toContain("new-workspace");
  });

  // The reported bug, from the search side: the cheat sheet has to stop finding
  // a row by keys the user has rebound away from.
  it("finds a rebound row by its new keys and not by the superseded default", () => {
    const overrides = { [NEW_WORKSPACE_BINDING]: "Cmd+Shift+K" };

    expect(matchedRowIds("cmd+shift+k", overrides)).toContain("new-workspace");
    expect(matchedRowIds("cmd+n", overrides)).not.toContain("new-workspace");
  });

  it("still finds an unassigned row by its label", () => {
    const overrides = { [NEW_WORKSPACE_BINDING]: UNASSIGNED_COMBO };

    expect(matchedRowIds("new workspace", overrides)).toContain("new-workspace");
    expect(matchedRowIds("cmd+n", overrides)).not.toContain("new-workspace");
  });

  it("keeps every row of a section whose own title matches", () => {
    const projects = filter("projects").find((section) => section.id === "projects");
    const allProjects = buildKeyboardShortcutHelpSections(MAC_DESKTOP).find(
      (section) => section.id === "projects",
    );

    expect(projects?.rows).toHaveLength(allProjects?.rows.length ?? 0);
  });

  it("drops a section whose rows all miss", () => {
    expect(filter("no shortcut spells this")).toEqual([]);
  });
});
