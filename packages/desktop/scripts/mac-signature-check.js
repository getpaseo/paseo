const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const EXECUTABLE_NAME = "PandaOS";
const FRAMEWORK_RELATIVE_PATHS = [
  ["Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework"],
  ["Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"],
];

// codesign -dvv writes to stderr. Ad-hoc builds report "TeamIdentifier=not
// set"; Developer ID builds report "TeamIdentifier=<TEAMID>".
function parseTeamIdentifier(output) {
  const text = String(output ?? "");
  if (text.includes("TeamIdentifier=not set")) {
    return "";
  }
  const match = text.match(/TeamIdentifier=([A-Za-z0-9]+)/);
  if (match) {
    return match[1];
  }
  // An Apple Distribution certificate prints no TeamIdentifier line at all; the
  // team sits in parentheses on the leaf Authority line. Without this the check
  // reads "no team" and fails a correctly signed build.
  const authority = text.match(/^Authority=.*\(([A-Z0-9]{10})\)\s*$/m);
  return authority ? authority[1] : null;
}

function defaultRunVvv(targetPath) {
  // codesign -dvv prints its report to stderr and still exits 0, so reading
  // stdout alone yields an empty string for every bundle, signed or not.
  const result = spawnSync("codesign", ["-dvv", targetPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (combined.includes("TeamIdentifier=") || combined.includes("Authority=")) {
    return combined;
  }
  if (result.status !== 0) {
    throw new Error(`codesign -dvv ${targetPath} exited with ${result.status}: ${combined.trim()}`);
  }
  return combined;
}

function defaultRunVerify(appPath) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function remediationHint(appPath) {
  return [
    "macOS refused to launch because the app bundle mixes binaries from different",
    'signing identities (DYLD "different Team IDs"). This happens when a new',
    "PandaOS.app is merged over an old one (Finder merge, unzip over /Applications,",
    "or an interrupted auto-update) instead of replacing it.",
    `Bundle: ${appPath}`,
    "Fix on the Mac: trash /Applications/PandaOS.app completely (do not merge),",
    "download the fresh PandaOS-<version>-arm64.dmg from the GitHub release, copy it",
    "into /Applications, then run: xattr -cr /Applications/PandaOS.app",
  ].join("\n");
}

function formatTeam(team) {
  return team === "" ? "(ad-hoc)" : team;
}

function readMainTeam({ appPath, executableName, runVvv }) {
  const mainExecutable = path.join(appPath, "Contents", "MacOS", executableName);
  const mainTeam = parseTeamIdentifier(runVvv(mainExecutable));
  if (mainTeam === null) {
    throw new Error(
      `Could not read TeamIdentifier for ${mainExecutable}.\n${remediationHint(appPath)}`,
    );
  }
  return { mainExecutable, mainTeam };
}

function readFrameworkTeam({ appPath, runVvv }) {
  let frameworkError = null;
  for (const parts of FRAMEWORK_RELATIVE_PATHS) {
    const candidate = path.join(appPath, ...parts);
    try {
      const team = parseTeamIdentifier(runVvv(candidate));
      if (team !== null) {
        return { frameworkPath: candidate, frameworkTeam: team };
      }
    } catch (error) {
      frameworkError = error;
    }
  }
  throw new Error(
    `Could not read TeamIdentifier for the Electron Framework in ${appPath}` +
      `${frameworkError ? `: ${frameworkError.message ?? frameworkError}` : "."}\n${remediationHint(appPath)}`,
    frameworkError ? { cause: frameworkError } : undefined,
  );
}

function assertTeamsMatch({ appPath, mainExecutable, mainTeam, frameworkPath, frameworkTeam }) {
  if (mainTeam !== frameworkTeam) {
    throw new Error(
      `Signature mismatch: ${mainExecutable} has TeamIdentifier=${formatTeam(mainTeam)} ` +
        `but ${frameworkPath} has TeamIdentifier=${formatTeam(frameworkTeam)}. ` +
        `macOS kills this at launch with DYLD "different Team IDs".\n${remediationHint(appPath)}`,
    );
  }
}

function assertExpectedTeam({ appPath, mainTeam, frameworkTeam, expectedTeamId }) {
  const expected = String(expectedTeamId ?? "").trim();
  if (expected && (mainTeam !== expected || frameworkTeam !== expected)) {
    throw new Error(
      `Signature mismatch: expected TeamIdentifier=${expected} (APPLE_TEAM_ID) ` +
        `but got main=${formatTeam(mainTeam)} ` +
        `framework=${formatTeam(frameworkTeam)}.\n${remediationHint(appPath)}`,
    );
  }
}

function assertNotAdhocRelease({ appPath, mainTeam, frameworkTeam, signedBuild }) {
  if (signedBuild && (mainTeam === "" || frameworkTeam === "")) {
    throw new Error(
      `Release macOS build is ad-hoc signed (TeamIdentifier not set) but CSC_LINK was provided. ` +
        `Ad-hoc release artifacts break Gatekeeper and auto-updates.\n${remediationHint(appPath)}`,
    );
  }
}

function runDeepVerify({ appPath, runVerify }) {
  try {
    runVerify(appPath);
  } catch (error) {
    throw new Error(
      `codesign --verify --deep --strict failed for ${appPath}: ${error?.message ?? error}\n${remediationHint(appPath)}`,
      { cause: error },
    );
  }
}

// Throws when the bundle would die at launch with DYLD "different Team IDs".
// Ad-hoc local builds (both sides "") pass; anything mixed fails the build.
function verifyMacBundleSignatures(options) {
  const {
    appPath,
    executableName = EXECUTABLE_NAME,
    expectedTeamId = "",
    signedBuild = false,
    runVvv = defaultRunVvv,
    runVerify = defaultRunVerify,
  } = options ?? {};
  if (!appPath) {
    throw new Error("verifyMacBundleSignatures requires appPath");
  }

  const { mainExecutable, mainTeam } = readMainTeam({ appPath, executableName, runVvv });
  const { frameworkPath, frameworkTeam } = readFrameworkTeam({ appPath, runVvv });
  assertTeamsMatch({ appPath, mainExecutable, mainTeam, frameworkPath, frameworkTeam });
  assertExpectedTeam({ appPath, mainTeam, frameworkTeam, expectedTeamId });
  assertNotAdhocRelease({ appPath, mainTeam, frameworkTeam, signedBuild });
  runDeepVerify({ appPath, runVerify });

  return { mainExecutable, frameworkPath, teamId: mainTeam };
}

module.exports = {
  EXECUTABLE_NAME,
  parseTeamIdentifier,
  verifyMacBundleSignatures,
};
