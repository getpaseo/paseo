import { describe, expect, test } from "vitest";

import {
  diffWorkspaceGitRefs,
  diffWorkspaceGitRemoteRefs,
  fetchWorkspaceGitRemote,
  parseWorkspaceGitRefs,
} from "./workspace-git-fetch.js";
import type { RunGitCommand } from "../utils/run-git-command.js";

describe("workspace Git remote refs", () => {
  test("runs the complete fetch through the supplied Git runner", async () => {
    const commands: string[][] = [];
    let refRead = 0;
    const runGitCommand: RunGitCommand = async (args) => {
      commands.push(args);
      const stdout =
        args[0] === "for-each-ref"
          ? `refs/remotes/origin/main\0${refRead++ === 0 ? "aaaaaaaa" : "bbbbbbbb"}`
          : "";
      return { stdout, stderr: "", truncated: false, exitCode: 0, signal: null };
    };

    await expect(
      fetchWorkspaceGitRemote("/repo", { onRefSnapshot() {} }, runGitCommand),
    ).resolves.toMatchObject({
      changes: [
        {
          kind: "moved",
          ref: "origin/main",
          beforeOid: "aaaaaaaa",
          afterOid: "bbbbbbbb",
        },
      ],
    });
    expect(commands).toEqual([
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
      ["fetch", "origin", "--prune"],
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
    ]);
  });

  test("parses refs for semantic before/after comparison", () => {
    expect(
      parseWorkspaceGitRefs(
        [
          "refs/remotes/origin/main\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "refs/remotes/upstream/topic\0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "refs/heads/main\0cccccccccccccccccccccccccccccccccccccccc",
        ].join("\n"),
      ),
    ).toEqual(
      new Map([
        ["refs/remotes/origin/main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        ["refs/remotes/upstream/topic", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        ["refs/heads/main", "cccccccccccccccccccccccccccccccccccccccc"],
      ]),
    );
  });

  test("distinguishes remote changes from concurrent local ref changes", () => {
    expect(
      diffWorkspaceGitRefs(
        new Map([
          ["refs/remotes/origin/main", "aaaaaaaa"],
          ["refs/heads/topic", "bbbbbbbb"],
        ]),
        new Map([
          ["refs/remotes/origin/main", "cccccccc"],
          ["refs/heads/topic", "dddddddd"],
        ]),
      ),
    ).toEqual({
      remoteChanges: [
        {
          kind: "moved",
          ref: "origin/main",
          beforeOid: "aaaaaaaa",
          afterOid: "cccccccc",
        },
      ],
      nonRemoteRefsChanged: true,
    });
  });

  test("reports added, changed, and deleted remote refs", () => {
    expect(
      diffWorkspaceGitRemoteRefs(
        new Map([
          ["origin/main", "aaaaaaaa"],
          ["origin/deleted", "bbbbbbbb"],
          ["origin/unchanged", "cccccccc"],
        ]),
        new Map([
          ["origin/main", "dddddddd"],
          ["origin/added", "eeeeeeee"],
          ["origin/unchanged", "cccccccc"],
        ]),
      ),
    ).toEqual([
      {
        kind: "moved",
        ref: "origin/main",
        beforeOid: "aaaaaaaa",
        afterOid: "dddddddd",
      },
      { kind: "added", ref: "origin/added", afterOid: "eeeeeeee" },
      { kind: "deleted", ref: "origin/deleted", beforeOid: "bbbbbbbb" },
    ]);
  });
});
