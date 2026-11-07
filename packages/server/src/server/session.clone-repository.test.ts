import { describe, expect, test } from "vitest";

import { normalizeCloneRepository } from "./session.js";

describe("normalizeCloneRepository", () => {
  test("keeps bare owner/repo shorthand on GitHub", () => {
    expect(normalizeCloneRepository({ repo: "getpaseo/paseo", cloneProtocol: "ssh" })).toEqual({
      name: "paseo",
      displayName: "getpaseo/paseo",
      cloneUrl: "git@github.com:getpaseo/paseo.git",
    });
    expect(normalizeCloneRepository({ repo: "getpaseo/paseo", cloneProtocol: "https" })).toEqual({
      name: "paseo",
      displayName: "getpaseo/paseo",
      cloneUrl: "https://github.com/getpaseo/paseo.git",
    });
  });

  test("routes host-qualified shorthand to that host over ssh", () => {
    expect(
      normalizeCloneRepository({ repo: "git.example.com/acme/widget", cloneProtocol: "ssh" }),
    ).toEqual({
      name: "widget",
      displayName: "git.example.com/acme/widget",
      cloneUrl: "git@git.example.com:acme/widget.git",
    });
  });

  test("routes host-qualified shorthand to that host over https", () => {
    expect(
      normalizeCloneRepository({ repo: "codeberg.org/acme/widget", cloneProtocol: "https" }),
    ).toEqual({
      name: "widget",
      displayName: "codeberg.org/acme/widget",
      cloneUrl: "https://codeberg.org/acme/widget.git",
    });
  });

  test("keeps nested paths intact, so a GitLab subgroup survives", () => {
    expect(
      normalizeCloneRepository({ repo: "gitlab.com/group/sub/widget", cloneProtocol: "ssh" }),
    ).toEqual({
      name: "widget",
      displayName: "gitlab.com/group/sub/widget",
      cloneUrl: "git@gitlab.com:group/sub/widget.git",
    });
  });

  test("strips a trailing .git from the repository name", () => {
    expect(
      normalizeCloneRepository({ repo: "git.example.com/acme/widget.git", cloneProtocol: "ssh" }),
    ).toEqual({
      name: "widget",
      displayName: "git.example.com/acme/widget",
      cloneUrl: "git@git.example.com:acme/widget.git",
    });
  });

  test("passes complete remote URLs through, needing no protocol", () => {
    expect(normalizeCloneRepository({ repo: "git@git.example.com:acme/widget.git" })).toEqual({
      name: "widget",
      displayName: "acme/widget",
      cloneUrl: "git@git.example.com:acme/widget.git",
    });
  });

  test("still requires a protocol for shorthand", () => {
    expect(() => normalizeCloneRepository({ repo: "git.example.com/acme/widget" })).toThrow(
      "Clone protocol is required",
    );
  });

  test("rejects a three-segment path whose first segment is not a host", () => {
    expect(() =>
      normalizeCloneRepository({ repo: "group/sub/widget", cloneProtocol: "ssh" }),
    ).toThrow("owner/repo format");
  });

  test("rejects shorthand with no repository name", () => {
    expect(() => normalizeCloneRepository({ repo: "getpaseo", cloneProtocol: "ssh" })).toThrow(
      "owner/repo format",
    );
  });

  test("rejects segments containing invalid characters", () => {
    expect(() =>
      normalizeCloneRepository({ repo: "git.example.com/acme/wid get", cloneProtocol: "ssh" }),
    ).toThrow("invalid characters");
  });
});
