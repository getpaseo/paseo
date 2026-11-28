import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLISH_WORKSPACES,
  getNpmStdio,
  publishReleasePackages,
} from "./publish-release-packages.mjs";

const noSleep = () => Promise.resolve();

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "", status = 1, stdout = "") {
  return { status, stdout, stderr };
}

test("publishes all workspaces in dependency order, waits for propagation, and advances beta dist-tag on stable", async () => {
  const calls = [];
  const published = new Set();

  await publishReleasePackages(
    { version: "0.17.0", beta: false, dryRun: false },
    {
      sleep: noSleep,
      runNpm(args) {
        calls.push(args);
        if (args[0] === "view" && args[2] === "version") {
          const spec = args[1];
          return published.has(spec) ? ok(JSON.stringify("0.17.0")) : fail("npm error code E404");
        }
        if (args[0] === "publish") {
          const pkg = args
            .find((arg) => arg.startsWith("--workspace="))
            .slice("--workspace=".length);
          published.add(`${pkg}@0.17.0`);
          return ok();
        }
        if (args[0] === "view" && args[2] === "dist-tags") {
          return ok(JSON.stringify({ latest: "0.16.2", beta: "0.17.0-beta.2" }));
        }
        if (args[0] === "dist-tag" && args[1] === "add") {
          return ok();
        }
        throw new Error(`Unexpected npm args: ${args.join(" ")}`);
      },
    },
  );

  const publishOrder = calls
    .filter((args) => args[0] === "publish")
    .map((args) => args.find((arg) => arg.startsWith("--workspace=")).slice("--workspace=".length));
  assert.deepEqual(publishOrder, PUBLISH_WORKSPACES);

  const betaTagUpdates = calls
    .filter((args) => args[0] === "dist-tag" && args[1] === "add")
    .map((args) => [args[2], args[3]]);
  assert.deepEqual(
    betaTagUpdates,
    PUBLISH_WORKSPACES.map((pkg) => [`${pkg}@0.17.0`, "beta"]),
  );
});

test("skips already-published packages cleanly so partial failures can be rerun", async () => {
  const published = new Set([
    "@getpaseo/highlight@0.17.0-beta.2",
    "@getpaseo/relay@0.17.0-beta.2",
    "@getpaseo/protocol@0.17.0-beta.2",
  ]);
  const publishTargets = [];

  await publishReleasePackages(
    { version: "0.17.0-beta.2", beta: true, dryRun: false },
    {
      sleep: noSleep,
      runNpm(args) {
        if (args[0] === "view" && args[2] === "version") {
          return published.has(args[1])
            ? ok(JSON.stringify("0.17.0-beta.2"))
            : fail("npm error code E404");
        }
        if (args[0] === "publish") {
          assert.ok(args.includes("--tag") && args.includes("beta"));
          const pkg = args
            .find((arg) => arg.startsWith("--workspace="))
            .slice("--workspace=".length);
          publishTargets.push(pkg);
          published.add(`${pkg}@0.17.0-beta.2`);
          return ok();
        }
        throw new Error(`Unexpected npm args: ${args.join(" ")}`);
      },
    },
  );

  assert.deepEqual(publishTargets, [
    "@getpaseo/client",
    "@getpaseo/plugin",
    "@getpaseo/server",
    "@getpaseo/cli",
  ]);
});

test("retries transient publish errors, waits for delayed registry propagation, and recovers EPUBLISHCONFLICT after timeout", async () => {
  const attempts = new Map();
  const visibilityChecks = new Map();
  const published = new Set();

  await publishReleasePackages(
    { version: "0.17.0-beta.2", beta: true, dryRun: false },
    {
      sleep: noSleep,
      runNpm(args) {
        if (args[0] === "view" && args[2] === "version") {
          const spec = args[1];
          if (!published.has(spec)) {
            return fail("npm error code E404");
          }
          const count = (visibilityChecks.get(spec) ?? 0) + 1;
          visibilityChecks.set(spec, count);
          // Simulate npm CDN lag on @getpaseo/server for 2 polls before becoming visible.
          if (spec === "@getpaseo/server@0.17.0-beta.2" && count < 3) {
            return fail("npm error code E404");
          }
          return ok(JSON.stringify("0.17.0-beta.2"));
        }
        if (args[0] === "publish") {
          const pkg = args
            .find((arg) => arg.startsWith("--workspace="))
            .slice("--workspace=".length);
          const count = (attempts.get(pkg) ?? 0) + 1;
          attempts.set(pkg, count);
          if (pkg === "@getpaseo/client" && count === 1) {
            return fail("npm error code E503\n503 Service Unavailable");
          }
          if (pkg === "@getpaseo/server" && count === 1) {
            // Timed out after npm accepted the tarball.
            published.add(`${pkg}@0.17.0-beta.2`);
            return fail("npm error code ETIMEDOUT");
          }
          if (pkg === "@getpaseo/server" && count === 2) {
            return fail(
              "npm error code E403\nYou cannot publish over the previously published versions: 0.17.0-beta.2.",
            );
          }
          published.add(`${pkg}@0.17.0-beta.2`);
          return ok();
        }
        throw new Error(`Unexpected npm args: ${args.join(" ")}`);
      },
    },
  );

  assert.equal(attempts.get("@getpaseo/client"), 2);
  assert.equal(attempts.get("@getpaseo/server"), 2);
  assert.equal(visibilityChecks.get("@getpaseo/server@0.17.0-beta.2"), 3);
});

test("does not retry deterministic npm auth errors", async () => {
  let publishAttempts = 0;

  await assert.rejects(
    () =>
      publishReleasePackages(
        { version: "0.17.0-beta.2", beta: true, dryRun: false },
        {
          sleep: noSleep,
          runNpm(args) {
            if (args[0] === "view") {
              return fail("npm error code E404");
            }
            publishAttempts += 1;
            return fail("npm error code ENEEDAUTH\nYou must be logged in to publish packages.");
          },
        },
      ),
    /ENEEDAUTH|logged in/,
  );

  assert.equal(publishAttempts, 1);
});

test("leaves beta dist-tag untouched when a stable hotfix is older than the active beta", async () => {
  const calls = [];
  const published = new Set();

  await publishReleasePackages(
    { version: "0.16.3", beta: false, dryRun: false },
    {
      sleep: noSleep,
      runNpm(args) {
        calls.push(args);
        if (args[0] === "view" && args[2] === "version") {
          return published.has(args[1])
            ? ok(JSON.stringify("0.16.3"))
            : fail("npm error code E404");
        }
        if (args[0] === "publish") {
          const pkg = args
            .find((arg) => arg.startsWith("--workspace="))
            .slice("--workspace=".length);
          published.add(`${pkg}@0.16.3`);
          return ok();
        }
        if (args[0] === "view" && args[2] === "dist-tags") {
          return ok(JSON.stringify({ latest: "0.16.2", beta: "0.17.0-beta.1" }));
        }
        throw new Error(`Unexpected npm args: ${args.join(" ")}`);
      },
    },
  );

  assert.equal(
    calls.some((args) => args[0] === "dist-tag"),
    false,
  );
});

test("rejects channel and version mismatches", async () => {
  await assert.rejects(
    () =>
      publishReleasePackages(
        { version: "0.17.0-beta.2", beta: false, dryRun: true },
        { runNpm: () => ok(), sleep: noSleep },
      ),
    /prerelease.*--beta/i,
  );

  await assert.rejects(
    () =>
      publishReleasePackages(
        { version: "0.17.0", beta: true, dryRun: true },
        { runNpm: () => ok(), sleep: noSleep },
      ),
    /stable.*--beta/i,
  );
});

test("dry-run skips registry queries, propagation polling, and dist-tag sync", async () => {
  const calls = [];

  await publishReleasePackages(
    { version: "0.17.0", beta: false, dryRun: true },
    {
      sleep: noSleep,
      runNpm(args) {
        calls.push(args);
        return ok();
      },
    },
  );

  assert.equal(calls.length, PUBLISH_WORKSPACES.length);
  for (const args of calls) {
    assert.equal(args[0], "publish");
    assert.ok(args.includes("--dry-run"));
  }
});

test("inherits TTY stdin/stdout for interactive publish and dist-tag OTP prompts while keeping stderr piped", () => {
  assert.deepEqual(getNpmStdio({ interactive: true, stdinIsTTY: true, stdoutIsTTY: true }), [
    "inherit",
    "inherit",
    "pipe",
  ]);
  assert.deepEqual(getNpmStdio({ interactive: false, stdinIsTTY: true, stdoutIsTTY: true }), [
    "ignore",
    "pipe",
    "pipe",
  ]);
  assert.deepEqual(getNpmStdio({ interactive: true, stdinIsTTY: false, stdoutIsTTY: true }), [
    "ignore",
    "pipe",
    "pipe",
  ]);
});

test("marks publish and dist-tag invocations interactive and forwards --otp when supplied", async () => {
  const recorded = [];
  const published = new Set();

  await publishReleasePackages(
    { version: "0.17.0", beta: false, dryRun: false, otp: "123456" },
    {
      sleep: noSleep,
      runNpm(args, options) {
        recorded.push({ args, interactive: Boolean(options?.interactive) });
        if (args[0] === "view" && args[2] === "version") {
          return published.has(args[1])
            ? ok(JSON.stringify("0.17.0"))
            : fail("npm error code E404");
        }
        if (args[0] === "publish") {
          const pkg = args
            .find((arg) => arg.startsWith("--workspace="))
            .slice("--workspace=".length);
          published.add(`${pkg}@0.17.0`);
          return ok();
        }
        if (args[0] === "view" && args[2] === "dist-tags") {
          return ok(JSON.stringify({ latest: "0.16.2", beta: "0.17.0-beta.2" }));
        }
        return ok();
      },
    },
  );

  for (const entry of recorded) {
    if (entry.args[0] === "view") {
      assert.equal(entry.interactive, false);
    } else {
      assert.equal(entry.interactive, true);
      assert.ok(entry.args.includes("--otp=123456"));
    }
  }
});
