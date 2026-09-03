import { describe, expect, it } from "vitest";

import {
  collectComposerTokens,
  collectSubmittedComposerTokens,
  getComposerTokenDisplayText,
  segmentComposerText,
  type ComposerTokenCatalog,
} from "./tokens";

const tokenCatalog = {
  commandNames: new Set(["plan", "review"]),
  skillNames: new Set(["one", "release-beta", "release-stable", "review", "two"]),
} satisfies ComposerTokenCatalog;

describe("collectComposerTokens", () => {
  it("finds a skill token mid-sentence", () => {
    expect(collectComposerTokens("please run /release-beta now", tokenCatalog)).toEqual([
      { type: "skill", name: "release-beta", start: 11, end: 24 },
    ]);
  });

  it("finds a command token only at the start of the prompt", () => {
    expect(collectComposerTokens("/review", tokenCatalog)).toEqual([
      { type: "command", name: "review", start: 0, end: 7 },
    ]);
    expect(collectComposerTokens("first\n/review", tokenCatalog)).toEqual([
      { type: "skill", name: "review", start: 6, end: 13 },
    ]);
  });

  it("treats canonical slash syntax as a skill inline", () => {
    expect(collectComposerTokens("and/or, read a/b", tokenCatalog)).toEqual([]);
    expect(collectComposerTokens("use /review here", tokenCatalog)).toEqual([
      { type: "skill", name: "review", start: 4, end: 11 },
    ]);
  });

  it("does not treat slash-delimited paths as tokens", () => {
    expect(collectComposerTokens("read /tmp/project", tokenCatalog)).toEqual([]);
  });

  it("does not treat uncommitted configured sigils as tokens", () => {
    const shellCollisionCatalog = {
      commandNames: new Set(["HOME", "project"]),
      skillNames: new Set(["HOME", "project", "release-beta"]),
    };
    expect(
      collectComposerTokens(
        "check $HOME and $project, then run $release-beta",
        shellCollisionCatalog,
      ),
    ).toEqual([]);
  });

  it("ignores a bare sigil with no name", () => {
    expect(collectComposerTokens("/ /2", tokenCatalog)).toEqual([]);
  });

  it("ignores token-shaped text that is not in the command catalog", () => {
    expect(collectComposerTokens("use /unknown before /heading", tokenCatalog)).toEqual([]);
  });

  it("collects several tokens in one draft", () => {
    const text = "/plan then /release-beta and /release-stable";
    expect(collectComposerTokens(text, tokenCatalog).map((token) => token.name)).toEqual([
      "plan",
      "release-beta",
      "release-stable",
    ]);
  });

  it("stops a name at the first character outside the token charset", () => {
    expect(collectComposerTokens("run /release-beta, then", tokenCatalog)).toEqual([
      { type: "skill", name: "release-beta", start: 4, end: 17 },
    ]);
  });
});

describe("submitted composer token presentation", () => {
  it("recovers command and skill tokens from canonical slash syntax", () => {
    expect(collectSubmittedComposerTokens("/plan then /release-beta")).toEqual([
      { type: "command", name: "plan", start: 0, end: 5 },
      { type: "skill", name: "release-beta", start: 11, end: 24 },
    ]);
  });

  it("maps canonical tokens back to the active display sigils", () => {
    const remapped = { command: "#", skill: "!" } as const;
    expect(getComposerTokenDisplayText({ type: "command", name: "plan" }, remapped)).toBe("#plan");
    expect(getComposerTokenDisplayText({ type: "skill", name: "release-beta" }, remapped)).toBe(
      "!release-beta",
    );
  });

  it("keeps paths and ordinary slash prose out of sent-message pills", () => {
    expect(collectSubmittedComposerTokens("read /tmp/project and/or continue")).toEqual([]);
  });
});

describe("segmentComposerText", () => {
  it("covers the whole string in order", () => {
    const text = "please run /release-beta now";
    const segments = segmentComposerText(text, collectComposerTokens(text, tokenCatalog));

    expect(segments).toEqual([
      { kind: "text", text: "please run ", start: 0 },
      {
        kind: "token",
        text: "/release-beta",
        start: 11,
        token: { type: "skill", name: "release-beta", start: 11, end: 24 },
      },
      { kind: "text", text: " now", start: 24 },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("returns a single text segment when there are no tokens", () => {
    expect(segmentComposerText("plain draft", [])).toEqual([
      { kind: "text", text: "plain draft", start: 0 },
    ]);
  });

  it("returns nothing for an empty draft", () => {
    expect(segmentComposerText("", [])).toEqual([]);
  });

  it("keeps adjacent tokens contiguous", () => {
    const text = "/one /two";
    const segments = segmentComposerText(text, collectComposerTokens(text, tokenCatalog));
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });
});
