import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getGitHubRelease, getReleaseLookupTag } from "./github-release.mjs";
import { syncReleaseNotes } from "./sync-release-notes-from-changelog.mjs";

function withTempChangelog(fn, changelogText = "## 0.1.60-beta.1 - 2026-04-20\n\n- Beta notes.\n") {
  const previousCwd = process.cwd();
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-release-notes-test-"));
  process.chdir(tempDir);
  writeFileSync("CHANGELOG.md", changelogText);

  try {
    fn();
  } finally {
    process.chdir(previousCwd);
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function notFoundError() {
  return Object.assign(new Error("release not found"), { stderr: "gh: Not Found (HTTP 404)" });
}

test("uses the untagged URL slug for draft release CLI operations", () => {
  assert.equal(
    getReleaseLookupTag({
      draft: true,
      html_url: "https://github.com/getpaseo/paseo/releases/tag/untagged-draft",
      tag_name: "v0.1.60-beta.1",
    }),
    "untagged-draft",
  );
});

test("does not treat GitHub authentication failures as missing releases", () => {
  const calls = [];
  const authError = Object.assign(new Error("authentication failed"), {
    stderr: "gh: HTTP 401: Bad credentials",
  });
  assert.throws(
    () =>
      getGitHubRelease("getpaseo/paseo", "v0.1.60-beta.1", (command, args) => {
        calls.push({ args, command });
        throw authError;
      }),
    authError,
  );
  assert.equal(calls.length, 1, "authentication failures must not fall back to draft lookup");
});

test("updates an existing release body through the release id API", () => {
  withTempChangelog(() => {
    const calls = [];

    const execFileSync = (command, args, options) => {
      calls.push({ args, command, options });

      if (args[0] === "api" && args[1] === "repos/getpaseo/paseo/releases/tags/v0.1.60-beta.1") {
        return JSON.stringify({ id: 311163621, draft: false });
      }

      if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
        const notesArg = args.find((arg) => arg.startsWith("body=@"));
        assert.ok(notesArg, "PATCH should send the notes body from a file");
        const notesPath = notesArg.slice("body=@".length);
        assert.match(notesPath, /v0\.1\.60-beta\.1-notes\.md$/);
        return "";
      }

      throw new Error(`Unexpected gh call: ${command} ${args.join(" ")}`);
    };

    syncReleaseNotes(["--repo", "getpaseo/paseo", "--tag", "v0.1.60-beta.1"], {
      execFileSync,
    });

    assert.equal(
      calls.some((call) => call.args[0] === "release" && call.args[1] === "edit"),
      false,
      "retagged releases should not use gh release edit because it can resend tag_name",
    );
    assert.equal(
      calls.some(
        (call) =>
          call.args[0] === "api" &&
          call.args[1] === "-X" &&
          call.args[2] === "PATCH" &&
          call.args[3] === "repos/getpaseo/paseo/releases/311163621",
      ),
      true,
      "existing releases should be patched by release id",
    );
  });
});

test("updates a draft release body without publishing it", () => {
  withTempChangelog(() => {
    const calls = [];

    const execFileSync = (command, args, options) => {
      calls.push({ args, command, options });

      if (args[0] === "api" && args[1] === "repos/getpaseo/paseo/releases/tags/v0.1.60-beta.1") {
        throw notFoundError();
      }

      if (args[0] === "api" && args[1] === "repos/getpaseo/paseo/releases?per_page=100") {
        return JSON.stringify([
          {
            id: 311163621,
            draft: true,
            name: "Paseo v0.1.60-beta.1",
            tag_name: "untagged-draft",
            html_url: "https://github.com/getpaseo/paseo/releases/tag/untagged-draft",
          },
        ]);
      }

      if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
        return "[]";
      }

      throw new Error(`Unexpected gh call: ${command} ${args.join(" ")}`);
    };

    syncReleaseNotes(["--repo", "getpaseo/paseo", "--tag", "v0.1.60-beta.1"], {
      execFileSync,
    });

    const updateCall = calls.find(
      (call) => call.args[0] === "api" && call.args[1] === "-X" && call.args[2] === "PATCH",
    );
    assert.ok(updateCall, "the draft release should be updated");
    assert.deepEqual(
      updateCall.args.filter((arg) => arg.startsWith("draft=")),
      [],
      "updating notes must not change draft visibility",
    );
  });
});

test("creates missing beta releases as drafts", () => {
  withTempChangelog(() => {
    const calls = [];
    let created = false;

    const execFileSync = (command, args, options) => {
      calls.push({ args, command, options });

      if (args[0] === "api" && args[1] === "repos/getpaseo/paseo/releases/tags/v0.1.60-beta.1") {
        throw notFoundError();
      }

      if (args[0] === "api" && args[1] === "repos/getpaseo/paseo/releases?per_page=100") {
        return created
          ? JSON.stringify([
              {
                id: 311163621,
                draft: true,
                name: "Paseo v0.1.60-beta.1",
                tag_name: "v0.1.60-beta.1",
              },
            ])
          : "[]";
      }

      if (args[0] === "release" && args[1] === "create") {
        created = true;
        return "";
      }

      if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
        return "";
      }

      throw new Error(`Unexpected gh call: ${command} ${args.join(" ")}`);
    };

    syncReleaseNotes(
      ["--repo", "getpaseo/paseo", "--tag", "v0.1.60-beta.1", "--create-if-missing"],
      { execFileSync },
    );

    const createCall = calls.find(
      (call) => call.args[0] === "release" && call.args[1] === "create",
    );
    assert.ok(createCall, "the missing release should be created");
    assert.equal(createCall.args.includes("--draft"), true);
    assert.equal(createCall.args.includes("--prerelease"), true);
  });
});

test("converts contributor profile links to mentions in synced release notes", () => {
  const changelogText = [
    "## 0.1.60-beta.1 - 2026-04-20",
    "",
    "- Beta notes. ([#526](https://github.com/getpaseo/paseo/pull/526) by [@therainisme](https://github.com/therainisme))",
    "",
  ].join("\n");

  withTempChangelog(() => {
    let syncedNotes = "";

    const execFileSync = (command, args) => {
      if (args[0] === "api" && args[1] === "repos/getpaseo/paseo/releases/tags/v0.1.60-beta.1") {
        return JSON.stringify({ id: 311163621, draft: false });
      }

      if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
        const notesArg = args.find((arg) => arg.startsWith("body=@"));
        assert.ok(notesArg, "PATCH should send the notes body from a file");
        syncedNotes = readFileSync(notesArg.slice("body=@".length), "utf8");
        return "";
      }

      throw new Error(`Unexpected gh call: ${command} ${args.join(" ")}`);
    };

    syncReleaseNotes(["--repo", "getpaseo/paseo", "--tag", "v0.1.60-beta.1"], {
      execFileSync,
    });

    assert.match(syncedNotes, /by @therainisme\)/);
    assert.doesNotMatch(syncedNotes, /\[@therainisme\]\(https:\/\/github\.com\/therainisme\)/);
  }, changelogText);
});
