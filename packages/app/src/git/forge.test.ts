import { describe, expect, it } from "vitest";
import {
  buildForgeSignInCommand,
  forgeFromRemoteUrl,
  getForgePresentation,
  normalizeForge,
} from "./forge";

describe("normalizeForge", () => {
  it("maps the gitlab discriminant to gitlab", () => {
    expect(normalizeForge("gitlab")).toBe("gitlab");
  });

  it("keeps any non-empty forge id and defaults only absent values to github", () => {
    expect(normalizeForge("github")).toBe("github");
    expect(normalizeForge("gitea")).toBe("gitea");
    expect(normalizeForge("forgejo")).toBe("forgejo");
    expect(normalizeForge(undefined)).toBe("github");
    expect(normalizeForge(null)).toBe("github");
    // An unknown forge id is preserved (rendered neutrally), not collapsed to
    // GitHub, so a newer daemon's forge degrades gracefully on an older client.
    expect(normalizeForge("bitbucket")).toBe("bitbucket");
  });
});

describe("getForgePresentation", () => {
  it("keeps GitHub on the pull-request noun and the # prefix", () => {
    const github = getForgePresentation("github");
    expect(github.brandLabel).toBe("GitHub");
    expect(github.changeRequestAbbrev).toBe("PR");
    expect(github.numberPrefix).toBe("#");
    expect(github.issueNumberPrefix).toBe("#");
    expect(github.changeRequestContext).toBeUndefined();
  });

  it("relabels GitLab to the merge-request noun and the ! prefix", () => {
    const gitlab = getForgePresentation("gitlab");
    expect(gitlab.brandLabel).toBe("GitLab");
    expect(gitlab.changeRequestAbbrev).toBe("MR");
    expect(gitlab.numberPrefix).toBe("!");
    expect(gitlab.issueNumberPrefix).toBe("#");
    expect(gitlab.changeRequestContext).toBe("mr");
  });

  it("presents Gitea and Forgejo with GitHub nouns and the tea CLI", () => {
    expect(getForgePresentation("gitea")).toMatchObject({
      forge: "gitea",
      icon: "gitea",
      brandLabel: "Gitea",
      changeRequestAbbrev: "PR",
      numberPrefix: "#",
      issueNumberPrefix: "#",
      signInCli: "tea",
    });
    expect(getForgePresentation("forgejo")).toMatchObject({
      forge: "forgejo",
      icon: "forgejo",
      brandLabel: "Forgejo",
      changeRequestAbbrev: "PR",
      signInCli: "tea",
    });
    expect(getForgePresentation("codeberg")).toMatchObject({
      forge: "codeberg",
      icon: "codeberg",
      brandLabel: "Codeberg",
      changeRequestAbbrev: "PR",
      signInCli: "tea",
    });
  });
});

describe("forgeFromRemoteUrl", () => {
  it("detects only public forge hosts that are safe without daemon probing", () => {
    expect(forgeFromRemoteUrl("https://codeberg.org/example/repo.git")).toBe("codeberg");
    expect(forgeFromRemoteUrl("https://gitlab.com/example/repo.git")).toBe("gitlab");
    expect(forgeFromRemoteUrl("https://gitea.com/example/repo.git")).toBe("gitea");
  });

  it("does not classify self-managed hosts by substring", () => {
    expect(forgeFromRemoteUrl("git@gitlab.example.org:example/repo.git")).toBeNull();
    expect(forgeFromRemoteUrl("git@forgejo.example.org:example/repo.git")).toBeNull();
    expect(forgeFromRemoteUrl("https://notgitlab.example.org/example/repo.git")).toBeNull();
  });
});

describe("buildForgeSignInCommand", () => {
  it("uses tea login add for both Gitea-family presentations", () => {
    expect(buildForgeSignInCommand("gitea", "gitea.com")).toBe("tea login add");
    expect(buildForgeSignInCommand("forgejo", "forgejo.example.org")).toBe("tea login add");
    expect(buildForgeSignInCommand("codeberg", "codeberg.org")).toBe("tea login add");
  });

  it("uses plain gh auth login for GitHub (incl. the ssh.github.com endpoint)", () => {
    expect(buildForgeSignInCommand("github", "github.com")).toBe("gh auth login");
    expect(buildForgeSignInCommand("github", "ssh.github.com")).toBe("gh auth login");
  });

  it("targets the workspace host for self-hosted GitLab", () => {
    expect(buildForgeSignInCommand("gitlab", "gitlab.acme.com")).toBe(
      "glab auth login --hostname gitlab.acme.com",
    );
  });

  it("returns no sign-in command for an unknown forge with no known CLI", () => {
    expect(buildForgeSignInCommand("bitbucket", "bitbucket.org")).toBeNull();
  });
});
