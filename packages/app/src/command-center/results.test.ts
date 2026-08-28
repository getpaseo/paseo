import { describe, expect, it } from "vitest";
import type { CommandCenterContribution } from "./contributions";
import {
  buildContributionSections,
  filterAndRankBuiltInResults,
  joinSubtitleParts,
  moveActiveResultId,
  PINNED_SECTION_BAND,
  preserveActiveResultId,
  projectCommandCenterRows,
  type CommandCenterWorkspaceResult,
} from "./results";

function contribution(input: {
  id: string;
  group: string;
  groupRank: number;
  visibility?: "always" | "query";
}): CommandCenterContribution {
  return {
    ...input,
    rank: 0,
    keywords: [input.id],
    visibility: input.visibility ?? "always",
    run: () => undefined,
    presentation: {
      kind: "action",
      title: input.id,
      sectionTitle: input.group,
    },
  };
}

function action(input: {
  id: string;
  group: string;
  groupRank: number;
  rank?: number;
  title: string;
  subtitle?: string;
  keywords?: readonly string[];
  visibility?: "always" | "query";
}): CommandCenterContribution {
  return {
    id: input.id,
    group: input.group,
    groupRank: input.groupRank,
    rank: input.rank ?? 0,
    keywords: input.keywords ?? [],
    visibility: input.visibility ?? "always",
    run: () => undefined,
    presentation: {
      kind: "action",
      title: input.title,
      subtitle: input.subtitle,
      sectionTitle: input.group,
    },
  };
}

function choice(input: {
  id: string;
  group: string;
  groupRank: number;
  rank?: number;
  path: readonly [string, ...string[]];
  keywords?: readonly string[];
}): CommandCenterContribution {
  return {
    id: input.id,
    group: input.group,
    groupRank: input.groupRank,
    rank: input.rank ?? 0,
    keywords: input.keywords ?? [],
    visibility: "query",
    run: () => undefined,
    presentation: { kind: "choice", path: input.path, selected: false },
  };
}

/** The real Actions › Schedules contribution, shape-for-shape (root-registration.tsx). */
function schedulesAction(): CommandCenterContribution {
  return action({
    id: "schedules",
    group: "actions",
    groupRank: 0,
    rank: 4,
    title: "Schedules",
    keywords: ["schedules", "scheduled", "automation", "recurring"],
  });
}

/** The real Mode › Auto mode contribution, shape-for-shape (agent-control-contributions.ts). */
function autoModeChoice(): CommandCenterContribution {
  return choice({
    id: "mode:auto",
    group: "modes",
    groupRank: 1.2,
    path: ["Mode", "Auto mode"],
    keywords: ["access", "permission", "approval", "mode"],
  });
}

function workspace(id: string, title = id, subtitle = "host"): CommandCenterWorkspaceResult {
  return {
    kind: "workspace",
    id,
    title,
    subtitle,
    changeRequestNumber: null,
    run: () => undefined,
  };
}

function sectionResultIds(sections: ReturnType<typeof buildContributionSections>): string[] {
  const ids: string[] = [];
  for (const section of sections) {
    for (const result of section.results) ids.push(result.id);
  }
  return ids;
}

describe("Command Center result projection", () => {
  it("query-gates model choices and creates one flat row index", () => {
    const contributions = [
      contribution({ id: "settings", group: "actions", groupRank: 0 }),
      contribution({ id: "opus", group: "models", groupRank: 1, visibility: "query" }),
    ];
    const emptySections = buildContributionSections(contributions, "");
    expect(sectionResultIds(emptySections)).toEqual(["settings"]);

    const sections = buildContributionSections(contributions, "o");
    const projection = projectCommandCenterRows([
      ...sections,
      {
        id: "workspaces",
        band: PINNED_SECTION_BAND,
        rank: 2,
        title: "Workspaces",
        results: [workspace("workspace:1")],
      },
    ]);
    expect(projection.rows.map((row) => row.key)).toEqual([
      "section:models",
      "opus",
      "section:workspaces",
      "workspace:1",
    ]);
    expect(projection.rowIndexByResultId.get("workspace:1")).toBe(3);
    expect(projection.offsets).toEqual([0, 32, 68, 117]);
  });

  it("shows query-only actions only when their group matches a search", () => {
    const contributions = [
      contribution({ id: "settings", group: "actions", groupRank: 0 }),
      contribution({ id: "home", group: "actions", groupRank: 0, visibility: "query" }),
    ];

    expect(sectionResultIds(buildContributionSections(contributions, ""))).toEqual(["settings"]);
    expect(sectionResultIds(buildContributionSections(contributions, "home"))).toEqual(["home"]);
  });

  it("preserves active selection by id and falls back to the first result", () => {
    const first = workspace("workspace:first");
    const second = workspace("workspace:second");
    expect(preserveActiveResultId(second.id, [first, second])).toBe(second.id);
    expect(preserveActiveResultId("missing", [first, second])).toBe(first.id);
    expect(preserveActiveResultId(first.id, [])).toBeNull();
  });

  it("wraps keyboard selection in both directions", () => {
    const first = workspace("workspace:first");
    const second = workspace("workspace:second");
    expect(moveActiveResultId(second.id, [first, second], "next")).toBe(first.id);
    expect(moveActiveResultId(first.id, [first, second], "previous")).toBe(second.id);
  });

  it("keeps keyboard selection aligned with rows beyond the render window", () => {
    const workspaces = Array.from({ length: 200 }, (_, index) => workspace(`workspace:${index}`));
    const projection = projectCommandCenterRows([
      {
        id: "workspaces",
        band: PINNED_SECTION_BAND,
        rank: 0,
        title: "Workspaces",
        results: workspaces,
      },
    ]);

    let activeId: string | null = workspaces[0].id;
    for (let index = 0; index < 150; index += 1) {
      activeId = moveActiveResultId(activeId, projection.selectableResults, "next");
    }

    const targetId = workspaces[150].id;
    expect(activeId).toBe(targetId);
    expect(projection.rowIndexByResultId.get(targetId)).toBe(151);
    expect(projection.offsets[151]).toBe(32 + 150 * 56);
  });
});

describe("Command Center relevance ordering", () => {
  it("ranks a label match above a hidden-keyword match at every prefix", () => {
    // Reported bug: "Schedules" matched only via its hidden keyword "automation" yet outranked
    // "Auto mode", so Enter navigated to Schedules instead of switching permission mode.
    // Every prefix counts, not just the full word — you read the list while you type, and "aut"
    // is a string-prefix of both "Auto mode" and "automation", so match quality alone ties them.
    for (const query of ["a", "au", "aut", "auto"]) {
      const sections = buildContributionSections([schedulesAction(), autoModeChoice()], query);
      expect(
        sections.map((section) => section.id),
        `query ${query}`,
      ).toEqual(["modes", "actions"]);
      expect(sectionResultIds(sections), `query ${query}`).toEqual(["mode:auto", "schedules"]);
    }
  });

  it("prefers a visible label over an exact hidden keyword", () => {
    const sections = buildContributionSections(
      [
        action({
          id: "schedules",
          group: "actions",
          groupRank: 0,
          rank: 0,
          title: "Schedules",
          keywords: ["automation"],
        }),
        action({
          id: "automation-hub",
          group: "actions",
          groupRank: 0,
          rank: 1,
          title: "Automation hub",
        }),
      ],
      "automation",
    );

    // "automation" is an exact keyword on Schedules and only a prefix of the other label.
    // The visible match still wins — the deliberate trade-off of ranking by field role first.
    expect(sectionResultIds(sections)).toEqual(["automation-hub", "schedules"]);
  });

  it("keeps registry order when the query is empty", () => {
    const shuffled = [
      choice({ id: "mode:auto", group: "modes", groupRank: 1.2, path: ["Mode", "Auto mode"] }),
      schedulesAction(),
      action({ id: "new-agent", group: "workspace", groupRank: -1, title: "New agent" }),
    ];
    const projection = projectCommandCenterRows(buildContributionSections(shuffled, ""));

    // Query-gated choices stay hidden; the rest fall back to groupRank, unchanged by this feature.
    expect(projection.selectableResults.map((result) => result.id)).toEqual([
      "new-agent",
      "schedules",
    ]);
  });

  it("still ranks Schedules first for 'sched'", () => {
    const sections = buildContributionSections(
      [
        schedulesAction(),
        choice({
          id: "mode:auto",
          group: "modes",
          groupRank: 1.2,
          path: ["Mode", "Auto mode"],
          keywords: ["rescheduled"],
        }),
      ],
      "sched",
    );

    expect(sectionResultIds(sections)).toEqual(["schedules", "mode:auto"]);
  });

  it("orders rows within a section by match quality", () => {
    const sections = buildContributionSections(
      [
        action({ id: "reset", group: "actions", groupRank: 0, rank: 0, title: "Reset device" }),
        action({ id: "settings", group: "actions", groupRank: 0, rank: 1, title: "Settings" }),
      ],
      "set",
    );

    // "Settings" is a prefix match; "Reset device" only matches mid-word.
    expect(sectionResultIds(sections)).toEqual(["settings", "reset"]);
  });

  it("breaks an equal-score tie with registry order, not alphabetically", () => {
    const sections = buildContributionSections(
      [
        action({ id: "z-first", group: "actions", groupRank: 0, rank: 0, title: "Auto one" }),
        action({ id: "a-second", group: "actions", groupRank: 0, rank: 1, title: "Auto two" }),
      ],
      "auto",
    );

    expect(sectionResultIds(sections)).toEqual(["z-first", "a-second"]);
  });

  it("keeps Workspaces below contributions even on a perfect match", () => {
    const projection = projectCommandCenterRows([
      ...buildContributionSections([schedulesAction()], "auto"),
      {
        id: "workspaces",
        band: PINNED_SECTION_BAND,
        rank: 2,
        title: "Workspaces",
        results: [workspace("auto")],
      },
    ]);

    expect(projection.selectableResults.map((result) => result.id)).toEqual(["schedules", "auto"]);
  });

  it("sorts sections handed to it out of order", () => {
    const sections = buildContributionSections([schedulesAction(), autoModeChoice()], "auto");
    const workspaces = {
      id: "workspaces",
      band: PINNED_SECTION_BAND,
      rank: 2,
      title: "Workspaces",
      results: [workspace("auto")],
    };
    const projection = projectCommandCenterRows([workspaces, ...sections.toReversed()]);

    expect(projection.selectableResults.map((result) => result.id)).toEqual([
      "mode:auto",
      "schedules",
      "auto",
    ]);
  });

  it("still matches a query spanning two fields", () => {
    // Each token is scored against each field on its own, so "mode auto" lands one token in
    // path[0] and one in path[1]. Order is not significant — the reverse matches too.
    for (const query of ["mode auto", "auto mode"]) {
      expect(sectionResultIds(buildContributionSections([autoModeChoice()], query)), query).toEqual(
        ["mode:auto"],
      );
    }
  });
});

describe("Command Center query tokenization", () => {
  const labelAsDesign = () =>
    action({
      id: "label:design",
      group: "workspace",
      groupRank: 0,
      title: "Label as Design",
    });

  it("matches a multi-token query in any order", () => {
    // The reported bug: "design" found this row and "lab des" found nothing, because the whole
    // query was tested as one substring.
    for (const query of ["design", "lab des", "des lab", "Label as Design"]) {
      expect(sectionResultIds(buildContributionSections([labelAsDesign()], query)), query).toEqual([
        "label:design",
      ]);
    }
  });

  it("requires each token to be adjacent characters, not a subsequence", () => {
    // Unlike the composer's slash-command list, where "/pasbab" finds "/paseo-babysit". Dropping
    // the subsequence tier is what keeps "No matches" meaning no matches: this list preselects
    // its first row, so a query that should find nothing must not put an action under Enter.
    for (const query of ["labdes", "lbl", "lasdsgn"]) {
      expect(sectionResultIds(buildContributionSections([labelAsDesign()], query)), query).toEqual(
        [],
      );
    }
  });

  it("rejects the row when any single token matches nothing", () => {
    expect(sectionResultIds(buildContributionSections([labelAsDesign()], "lab zzz"))).toEqual([]);
  });

  it("treats a repeated token as idempotent", () => {
    // Each token is scored independently, so both find the same occurrence. Documented, not a bug.
    expect(sectionResultIds(buildContributionSections([labelAsDesign()], "lab lab"))).toEqual([
      "label:design",
    ]);
  });

  it("never drops a row that the old substring filter would have matched", () => {
    // Tokens hold no whitespace and the old haystack joined fields with a space, so any token
    // found in that haystack lay entirely within one field. Tokenizing can only widen.
    const rows = [labelAsDesign(), schedulesAction(), autoModeChoice()];
    const haystack = (row: CommandCenterContribution): string =>
      [
        ...(row.presentation.kind === "action"
          ? [row.presentation.title, row.presentation.subtitle ?? ""]
          : row.presentation.path),
        ...row.keywords,
      ]
        .join(" ")
        .toLowerCase();

    for (const query of ["design", "sched", "auto mode", "label as", "recurring", "mode"]) {
      const substringMatches = rows
        .filter((row) => haystack(row).includes(query.toLowerCase()))
        .map((row) => row.id);
      const tokenMatches = new Set(sectionResultIds(buildContributionSections(rows, query)));
      for (const id of substringMatches) {
        expect(tokenMatches.has(id), `${query} -> ${id}`).toBe(true);
      }
    }
  });

  it("matches one token against the title and another against the subtitle", () => {
    const sections = buildContributionSections(
      [
        action({
          id: "open-changes",
          group: "workspace",
          groupRank: 0,
          title: "Open Changes",
          subtitle: "Review the working tree",
        }),
      ],
      "changes tree",
    );

    expect(sectionResultIds(sections)).toEqual(["open-changes"]);
  });

  it("ranks a visible match above one that only a hidden keyword reached", () => {
    const sections = buildContributionSections(
      [
        action({
          id: "hidden-only",
          group: "actions",
          groupRank: 0,
          rank: 0,
          title: "Unrelated",
          keywords: ["label", "design"],
        }),
        labelAsDesign(),
      ],
      "lab des",
    );

    expect(sectionResultIds(sections)).toEqual(["label:design", "hidden-only"]);
  });

  it("returns everything for an empty or whitespace-only query", () => {
    for (const query of ["", "   "]) {
      expect(
        sectionResultIds(buildContributionSections([labelAsDesign(), schedulesAction()], query)),
        JSON.stringify(query),
      ).toEqual(["label:design", "schedules"]);
    }
  });
});

describe("filterAndRankBuiltInResults", () => {
  const visibleOnly = (row: CommandCenterWorkspaceResult) => ({
    visible: [row.title, row.subtitle],
    hidden: [],
  });
  const byTitle = (left: CommandCenterWorkspaceResult, right: CommandCenterWorkspaceResult) =>
    left.title.localeCompare(right.title);

  it("caps an empty query and preserves the caller's order", () => {
    const rows = Array.from({ length: 8 }, (_, index) => workspace(`w${index}`));

    expect(
      filterAndRankBuiltInResults(rows, "", visibleOnly, byTitle).map((row) => row.id),
    ).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  });

  it("puts the best match first even when it sorts last alphabetically", () => {
    const rows = [
      workspace("a", "Zebra design system"),
      workspace("b", "Alpha lab notes"),
      workspace("c", "Label as Design"),
    ];

    // Alphabetically this is Alpha, Label, Zebra. "lab des" only matches Label as Design.
    expect(
      filterAndRankBuiltInResults(rows, "lab des", visibleOnly, byTitle).map((row) => row.id),
    ).toEqual(["c"]);
  });

  it("ranks a title match above a match that only the hidden field reached", () => {
    const rows = [workspace("hidden-hit", "Unrelated"), workspace("title-hit", "Deploy")];
    const fields = (row: CommandCenterWorkspaceResult) =>
      row.id === "hidden-hit"
        ? { visible: [row.title], hidden: ["deploy"] }
        : { visible: [row.title], hidden: [] };

    expect(
      filterAndRankBuiltInResults(rows, "deploy", fields, byTitle).map((row) => row.id),
    ).toEqual(["title-hit", "hidden-hit"]);
  });

  it("breaks an equal score with the caller's tiebreak, not with match order", () => {
    // Both titles are an exact prefix match for "task", so only the tiebreak separates them.
    const rows = [workspace("second", "Task zebra"), workspace("first", "Task alpha")];

    expect(
      filterAndRankBuiltInResults(rows, "task", visibleOnly, byTitle).map((row) => row.id),
    ).toEqual(["first", "second"]);
  });

  it("drops a row when one token matches nothing", () => {
    const rows = [workspace("a", "Label as Design")];

    expect(filterAndRankBuiltInResults(rows, "lab zzz", visibleOnly, byTitle)).toEqual([]);
  });
});

describe("joinSubtitleParts", () => {
  it("joins all present parts with a middle dot", () => {
    expect(joinSubtitleParts(["a", "b", "c"])).toBe("a · b · c");
  });

  it("drops null and undefined parts", () => {
    expect(joinSubtitleParts(["host", null, "master"])).toBe("host · master");
    expect(joinSubtitleParts(["host", undefined, "master"])).toBe("host · master");
  });

  it("drops empty strings (Boolean parity — agents subtitle refactor guard)", () => {
    expect(joinSubtitleParts(["", "paseo", "master"])).toBe("paseo · master");
  });

  it("returns an empty string when every part is null or empty", () => {
    expect(joinSubtitleParts([null, undefined, ""])).toBe("");
  });

  it("returns a single part unchanged, with no separator", () => {
    expect(joinSubtitleParts([null, "paseo", null])).toBe("paseo");
  });

  it("builds the workspace subtitle in host · project · branch order", () => {
    // Single-host: host gated away, project leads.
    expect(joinSubtitleParts([null, "paseo", "master"])).toBe("paseo · master");
    // Multi-host: host first, then project, then branch.
    expect(joinSubtitleParts(["host", "paseo", "master"])).toBe("host · paseo · master");
    // No branch: degrades to project (or host · project).
    expect(joinSubtitleParts([null, "paseo", null])).toBe("paseo");
  });
});
