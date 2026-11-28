import { describe, expect, it } from "vitest";
import {
  AGENT_SHEET_HOME,
  projectAgentSheetProfiles,
  resolveAgentSheetEscape,
} from "./model-sheet-flow";

describe("agent settings sheet Escape", () => {
  it("clears a search before it leaves the page", () => {
    expect(resolveAgentSheetEscape({ page: { kind: "model" }, query: "opus" })).toBe("clearQuery");
  });

  it("returns from a page to home", () => {
    expect(resolveAgentSheetEscape({ page: { kind: "model" }, query: "" })).toBe("home");
    expect(resolveAgentSheetEscape({ page: { kind: "profiles" }, query: "  " })).toBe("home");
    expect(
      resolveAgentSheetEscape({ page: { kind: "select", controlId: "feature-branch" }, query: "" }),
    ).toBe("home");
  });

  it("closes the sheet from home", () => {
    expect(resolveAgentSheetEscape({ page: AGENT_SHEET_HOME, query: "" })).toBe("close");
  });
});

const profile = (id: string, name: string, summary: string) => ({
  id,
  name,
  summary,
  provider: "claude",
  modelId: "opus-5.5",
  icon: "",
  color: "",
});
const reviewer = profile("reviewer", "Reviewer", "Claude · Opus 5.5 · Plan");
const fixer = profile("fixer", "Bug fixer", "Codex · GPT-5.4");

describe("agent settings sheet Profiles page", () => {
  it("lists every profile in order", () => {
    expect(
      projectAgentSheetProfiles({ profiles: [reviewer, fixer], query: "", canCreate: true }),
    ).toEqual({
      kind: "list",
      items: [
        { kind: "profile", key: "profile:reviewer", profile: reviewer },
        { kind: "profile", key: "profile:fixer", profile: fixer },
      ],
    });
  });

  it("ranks the profiles that match the search", () => {
    const view = projectAgentSheetProfiles({
      profiles: [reviewer, fixer],
      query: " codex ",
      canCreate: true,
    });
    expect(view).toMatchObject({ kind: "list", items: [{ key: "profile:fixer" }] });
  });

  it("offers to create a profile when there are none", () => {
    expect(projectAgentSheetProfiles({ profiles: [], query: "", canCreate: true })).toEqual({
      kind: "list",
      items: [{ kind: "createProfile", key: "create-profile" }],
    });
    expect(projectAgentSheetProfiles({ profiles: [], query: "", canCreate: false })).toEqual({
      kind: "empty",
    });
  });

  it("says when no profile matches", () => {
    expect(
      projectAgentSheetProfiles({ profiles: [reviewer], query: " zzz ", canCreate: true }),
    ).toEqual({ kind: "noMatches", query: "zzz" });
  });
});
