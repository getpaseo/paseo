import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  detectIndexingTools,
  findBinary,
  meetsPythonMinimum,
  parsePythonVersion,
  suggestedInstallCommand,
  type DetectorEnv,
} from "./detector.js";

function makeEnv(overrides: Partial<DetectorEnv> = {}): DetectorEnv {
  return {
    pathDirs: ["/usr/bin", "/usr/local/bin"],
    pathExts: [""],
    platform: "linux",
    statFile: async () => false,
    versionOf: async () => null,
    ...overrides,
  };
}

describe("findBinary", () => {
  it("returns the resolved path when stat reports a file", async () => {
    const env = makeEnv({
      pathDirs: ["/a", "/b"],
      statFile: async (candidate) => candidate === path.join("/b", "code-review-graph"),
    });
    const result = await findBinary("code-review-graph", env);
    expect(result).toBe(path.join("/b", "code-review-graph"));
  });

  it("returns null when no PATH dir contains the binary", async () => {
    const env = makeEnv({ statFile: async () => false });
    expect(await findBinary("code-review-graph", env)).toBeNull();
  });

  it("respects Windows PATHEXT fallbacks (.exe, .cmd)", async () => {
    const env = makeEnv({
      platform: "win32",
      pathDirs: ["C:\\Tools"],
      pathExts: ["", ".exe", ".cmd"],
      statFile: async (candidate) => candidate.endsWith(".cmd"),
    });
    const result = await findBinary("pipx", env);
    expect(result).toBe(path.join("C:\\Tools", "pipx.cmd"));
  });
});

describe("parsePythonVersion", () => {
  it("parses canonical `Python X.Y.Z` output", () => {
    expect(parsePythonVersion("Python 3.11.4")).toEqual({ major: 3, minor: 11, patch: 4 });
  });

  it("parses missing-patch versions", () => {
    expect(parsePythonVersion("Python 3.12")).toEqual({ major: 3, minor: 12, patch: 0 });
  });

  it("returns null for empty / undefined / unparseable input", () => {
    expect(parsePythonVersion(undefined)).toBeNull();
    expect(parsePythonVersion("")).toBeNull();
    expect(parsePythonVersion("not a version")).toBeNull();
  });
});

describe("meetsPythonMinimum", () => {
  it.each([
    ["Python 3.10.0", true],
    ["Python 3.11", true],
    ["Python 3.12.5", true],
    ["Python 4.0.0", true],
    ["Python 3.9.18", false],
    ["Python 2.7.18", false],
    [undefined, false],
    ["bogus", false],
  ])("%s -> %s", (input, expected) => {
    expect(meetsPythonMinimum(input as string | undefined)).toBe(expected);
  });
});

describe("suggestedInstallCommand", () => {
  const baseDetection = {
    codeReviewGraph: { name: "code-review-graph", installed: false },
    pipx: { name: "pipx", installed: false },
    python3: { name: "python3", installed: false, meetsMinimumVersion: false as boolean },
  };

  it("returns null when crg is already installed", () => {
    expect(
      suggestedInstallCommand(
        { ...baseDetection, codeReviewGraph: { name: "code-review-graph", installed: true } },
        "linux",
      ),
    ).toBeNull();
  });

  it("uses pipx when pipx is present", () => {
    expect(
      suggestedInstallCommand(
        { ...baseDetection, pipx: { name: "pipx", installed: true } },
        "darwin",
      ),
    ).toBe("pipx install code-review-graph");
  });

  it("bootstraps pipx via python3 when python3 meets minimum", () => {
    expect(
      suggestedInstallCommand(
        {
          ...baseDetection,
          python3: { name: "python3", installed: true, meetsMinimumVersion: true },
        },
        "linux",
      ),
    ).toBe("python3 -m pip install --user pipx && pipx install code-review-graph");
  });

  it("does NOT use python3 when version is below minimum", () => {
    expect(
      suggestedInstallCommand(
        {
          ...baseDetection,
          python3: { name: "python3", installed: true, meetsMinimumVersion: false },
        },
        "darwin",
      ),
    ).toBe("brew install pipx && pipx install code-review-graph");
  });

  it("falls back per-platform when nothing is installed", () => {
    expect(suggestedInstallCommand(baseDetection, "darwin")).toContain("brew");
    expect(suggestedInstallCommand(baseDetection, "win32")).toContain("winget");
    expect(suggestedInstallCommand(baseDetection, "linux")).toContain("Python 3.10+");
  });
});

describe("detectIndexingTools", () => {
  it("reports all-installed when stat finds every binary", async () => {
    const env = makeEnv({
      pathDirs: ["/usr/bin"],
      statFile: async () => true,
      versionOf: async (binPath) => {
        if (binPath.endsWith("python3")) return "Python 3.12.0";
        if (binPath.endsWith("pipx")) return "pipx 1.4.3";
        if (binPath.endsWith("code-review-graph")) return "code-review-graph 2.4.1";
        return null;
      },
    });
    const result = await detectIndexingTools(env);
    expect(result.codeReviewGraph.installed).toBe(true);
    expect(result.codeReviewGraph.version).toBe("code-review-graph 2.4.1");
    expect(result.pipx.installed).toBe(true);
    expect(result.python3.installed).toBe(true);
    expect(result.python3.meetsMinimumVersion).toBe(true);
    expect(result.canInstall).toBe(true);
    expect(result.suggestedInstall).toBeNull();
  });

  it("flags python below minimum even when installed", async () => {
    const env = makeEnv({
      pathDirs: ["/usr/bin"],
      statFile: async (candidate) => candidate.endsWith("python3"),
      versionOf: async () => "Python 3.8.10",
    });
    const result = await detectIndexingTools(env);
    expect(result.python3.installed).toBe(true);
    expect(result.python3.meetsMinimumVersion).toBe(false);
    expect(result.canInstall).toBe(false);
  });

  it("returns canInstall=false and a platform-aware suggestion when nothing is found", async () => {
    const env = makeEnv({ statFile: async () => false, platform: "win32" });
    const result = await detectIndexingTools(env);
    expect(result.codeReviewGraph.installed).toBe(false);
    expect(result.pipx.installed).toBe(false);
    expect(result.python3.installed).toBe(false);
    expect(result.canInstall).toBe(false);
    expect(result.suggestedInstall).toContain("winget");
  });

  it("treats versionOf=null as missing version but still installed", async () => {
    const env = makeEnv({
      pathDirs: ["/usr/bin"],
      statFile: async (candidate) => candidate.endsWith("pipx"),
      versionOf: async () => null,
    });
    const result = await detectIndexingTools(env);
    expect(result.pipx.installed).toBe(true);
    expect(result.pipx.version).toBeUndefined();
    expect(result.canInstall).toBe(true);
    expect(result.suggestedInstall).toBe("pipx install code-review-graph");
  });
});
