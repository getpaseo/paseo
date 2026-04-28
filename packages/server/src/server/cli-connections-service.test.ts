import { describe, expect, test, vi, beforeEach } from "vitest";
import { buildCliAgentArgs } from "./cli-connections-service.js";

// Note: detectCliAgents calls execFile which requires system access.
// We test the pure logic (buildCliAgentArgs) thoroughly and keep the
// detection tests as smoke tests that may skip in CI.

describe("buildCliAgentArgs", () => {
  test("returns empty array for unknown provider", () => {
    const args = buildCliAgentArgs({ providerId: "nonexistent" as any });
    expect(args).toEqual([]);
  });

  describe("claude", () => {
    test("basic invocation returns empty args", () => {
      const args = buildCliAgentArgs({ providerId: "claude" });
      expect(args).toEqual([]);
    });

    test("auto-approve adds --dangerously-skip-permissions", () => {
      const args = buildCliAgentArgs({ providerId: "claude", autoApprove: true });
      expect(args).toContain("--dangerously-skip-permissions");
    });

    test("initial prompt is added as positional argument", () => {
      const args = buildCliAgentArgs({
        providerId: "claude",
        initialPrompt: "fix the login bug",
      });
      expect(args).toContain("fix the login bug");
    });

    test("resume adds -c -r flags", () => {
      const args = buildCliAgentArgs({ providerId: "claude", resume: true });
      expect(args).toContain("-c");
      expect(args).toContain("-r");
    });

    test("full combination: auto-approve + prompt + resume", () => {
      const args = buildCliAgentArgs({
        providerId: "claude",
        autoApprove: true,
        initialPrompt: "deploy to staging",
        resume: true,
      });
      // Order: resume, auto-approve, prompt
      expect(args.indexOf("-c")).toBeLessThan(args.indexOf("--dangerously-skip-permissions"));
      expect(args.indexOf("--dangerously-skip-permissions")).toBeLessThan(
        args.indexOf("deploy to staging"),
      );
    });
  });

  describe("codex", () => {
    test("auto-approve adds --full-auto", () => {
      const args = buildCliAgentArgs({ providerId: "codex", autoApprove: true });
      expect(args).toContain("--full-auto");
    });

    test("initial prompt is positional (flag is empty string)", () => {
      const args = buildCliAgentArgs({
        providerId: "codex",
        initialPrompt: "refactor utils",
      });
      expect(args).toContain("refactor utils");
    });

    test("resume adds resume --last", () => {
      const args = buildCliAgentArgs({ providerId: "codex", resume: true });
      expect(args).toContain("resume");
      expect(args).toContain("--last");
    });
  });

  describe("gemini", () => {
    test("auto-approve adds --yolo", () => {
      const args = buildCliAgentArgs({ providerId: "gemini", autoApprove: true });
      expect(args).toContain("--yolo");
    });

    test("initial prompt uses -i flag", () => {
      const args = buildCliAgentArgs({
        providerId: "gemini",
        initialPrompt: "add tests",
      });
      expect(args).toContain("-i");
      expect(args[args.indexOf("-i") + 1]).toBe("add tests");
    });

    test("resume adds --resume flag", () => {
      const args = buildCliAgentArgs({ providerId: "gemini", resume: true });
      expect(args).toContain("--resume");
    });
  });

  describe("cursor", () => {
    test("auto-approve adds -f", () => {
      const args = buildCliAgentArgs({ providerId: "cursor", autoApprove: true });
      expect(args).toContain("-f");
    });
  });

  describe("goose", () => {
    test("includes default args (run -s)", () => {
      const args = buildCliAgentArgs({ providerId: "goose" });
      expect(args).toContain("run");
      expect(args).toContain("-s");
    });

    test("initial prompt uses -t flag", () => {
      const args = buildCliAgentArgs({
        providerId: "goose",
        initialPrompt: "fix bug",
      });
      expect(args).toContain("-t");
      expect(args[args.indexOf("-t") + 1]).toBe("fix bug");
    });
  });

  describe("mistral", () => {
    test("auto-approve adds --auto-approve", () => {
      const args = buildCliAgentArgs({ providerId: "mistral", autoApprove: true });
      expect(args).toContain("--auto-approve");
    });

    test("initial prompt uses --prompt flag", () => {
      const args = buildCliAgentArgs({
        providerId: "mistral",
        initialPrompt: "optimize query",
      });
      expect(args).toContain("--prompt");
      expect(args[args.indexOf("--prompt") + 1]).toBe("optimize query");
    });
  });

  describe("keystroke injection providers", () => {
    test("amp does NOT add prompt as arg when useKeystrokeInjection is true", () => {
      const args = buildCliAgentArgs({
        providerId: "amp",
        initialPrompt: "fix it",
      });
      // Prompt should NOT appear because amp uses keystroke injection
      expect(args).not.toContain("fix it");
    });

    test("opencode does NOT add prompt as arg", () => {
      const args = buildCliAgentArgs({
        providerId: "opencode",
        initialPrompt: "build feature",
      });
      expect(args).not.toContain("build feature");
    });

    test("hermes does NOT add prompt as arg", () => {
      const args = buildCliAgentArgs({
        providerId: "hermes",
        initialPrompt: "debug this",
      });
      expect(args).not.toContain("debug this");
    });
  });

  describe("extra args", () => {
    test("extra args are appended", () => {
      const args = buildCliAgentArgs({
        providerId: "claude",
        extraArgs: ["--custom-flag", "value"],
      });
      expect(args).toContain("--custom-flag");
      expect(args).toContain("value");
    });

    test("extra args come after auto-approve", () => {
      const args = buildCliAgentArgs({
        providerId: "claude",
        autoApprove: true,
        extraArgs: ["--verbose"],
      });
      const autoIdx = args.indexOf("--dangerously-skip-permissions");
      const extraIdx = args.indexOf("--verbose");
      expect(extraIdx).toBeGreaterThan(autoIdx);
    });
  });

  describe("auggie", () => {
    test("includes --allow-indexing in default args", () => {
      const args = buildCliAgentArgs({ providerId: "auggie" });
      expect(args).toContain("--allow-indexing");
    });
  });

  describe("rovo", () => {
    test("auto-approve adds --yolo", () => {
      const args = buildCliAgentArgs({ providerId: "rovo", autoApprove: true });
      expect(args).toContain("--yolo");
    });
  });

  describe("kiro", () => {
    test("includes default args (chat)", () => {
      const args = buildCliAgentArgs({ providerId: "kiro" });
      expect(args).toContain("chat");
    });
  });
});
