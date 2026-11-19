import { describe, expect, it } from "vitest";
import { createForgeShorthand } from "./shorthand";

function matches(shorthand: { pattern: string }, text: string): string[] {
  return [...text.matchAll(new RegExp(shorthand.pattern, "g"))].map((match) => match[0]);
}

describe("createForgeShorthand", () => {
  const github = createForgeShorthand({
    forge: "github",
    remoteUrl: "git@github.com:getpaseo/paseo.git",
  })!;
  const gitlab = createForgeShorthand({
    forge: "gitlab",
    remoteUrl: "https://gitlab.com/g/p.git",
  })!;

  it("resolves same-repo and cross-repo references on the remote's host", () => {
    expect(github.resolve("#8613")).toBe("https://github.com/getpaseo/paseo/issues/8613");
    expect(github.resolve("acme/tools#4")).toBe("https://github.com/acme/tools/issues/4");
    expect(gitlab.resolve("!7")).toBe("https://gitlab.com/g/p/-/merge_requests/7");
    expect(gitlab.resolve("g/sub/q#3")).toBe("https://gitlab.com/g/sub/q/-/issues/3");
  });

  it("links numbers to the repository the daemon says owns them, but keeps explicit references", () => {
    const fork = createForgeShorthand({
      forge: "github",
      remoteUrl: "git@github.com-work:fork-owner/repo.git",
      forgeWeb: { host: "github.com", referenceRepository: "main-owner/repo" },
    })!;

    expect(fork.resolve("#123")).toBe("https://github.com/main-owner/repo/issues/123");
    expect(fork.resolve("acme/tools#4")).toBe("https://github.com/acme/tools/issues/4");
  });

  it("only recognizes the sigils the forge declares", () => {
    expect(matches(github, "see #1 and !2")).toEqual(["#1"]);
    expect(github.resolve("!2")).toBeNull();
    expect(matches(gitlab, "see #1 and !2")).toEqual(["#1", "!2"]);
  });

  it("recognizes references only at word boundaries", () => {
    expect(
      matches(
        github,
        "(#1), #2. acme/tools#3, foo#4 #5abc &#6; https://x/#7 #0 #08 wow!9 user@host#10",
      ),
    ).toEqual(["#1", "#2", "acme/tools#3"]);
  });

  it("falls back to the cloud host forge when the daemon reports none", () => {
    expect(
      createForgeShorthand({ forge: undefined, remoteUrl: "git@github.com:a/b.git" })?.resolve(
        "#1",
      ),
    ).toBe("https://github.com/a/b/issues/1");
  });

  it("is absent without a remote or a known forge", () => {
    expect(createForgeShorthand({ forge: "github", remoteUrl: null })).toBeNull();
    expect(
      createForgeShorthand({ forge: undefined, remoteUrl: "git@git.corp:a/b.git" }),
    ).toBeNull();
  });
});
