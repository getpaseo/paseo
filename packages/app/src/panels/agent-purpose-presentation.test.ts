import { describe, expect, it } from "vitest";
import { buildAgentPurposePresentation } from "./agent-purpose-presentation";

describe("buildAgentPurposePresentation", () => {
  it("uses the summary in pane chrome and includes the title in the tooltip", () => {
    expect(
      buildAgentPurposePresentation({
        label: "Agent summaries",
        summary: "Propagating summaries through app state",
        providerLabel: "Codex",
      }),
    ).toEqual({
      subtitle: "Propagating summaries through app state",
      tooltip: "Agent summaries\nPropagating summaries through app state",
    });
  });

  it("keeps the provider fallback when no summary is available", () => {
    expect(
      buildAgentPurposePresentation({
        label: "Agent summaries",
        summary: null,
        providerLabel: "Codex",
      }),
    ).toEqual({
      subtitle: "Codex agent",
      tooltip: "Agent summaries",
    });
  });
});
