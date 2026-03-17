import { describe, it, expect } from "vitest";
import { runDoctorChecks } from "./run-doctor-checks.js";
import type { DoctorReport, DoctorCheckResult } from "./types.js";

describe("runDoctorChecks", () => {
  it("returns a valid DoctorReport shape", async () => {
    const report = await runDoctorChecks();

    expect(report).toHaveProperty("checks");
    expect(report).toHaveProperty("summary");
    expect(report).toHaveProperty("timestamp");
    expect(Array.isArray(report.checks)).toBe(true);
  });

  it("has summary counts matching checks array", async () => {
    const report = await runDoctorChecks();

    const okCount = report.checks.filter((c) => c.status === "ok").length;
    const warnCount = report.checks.filter((c) => c.status === "warn").length;
    const errorCount = report.checks.filter((c) => c.status === "error").length;

    expect(report.summary.ok).toBe(okCount);
    expect(report.summary.warn).toBe(warnCount);
    expect(report.summary.error).toBe(errorCount);
    expect(okCount + warnCount + errorCount).toBe(report.checks.length);
  });

  it("has a valid ISO timestamp", async () => {
    const report = await runDoctorChecks();
    const parsed = new Date(report.timestamp);
    expect(parsed.toISOString()).toBe(report.timestamp);
  });

  it("each check has the expected shape", async () => {
    const report = await runDoctorChecks();

    for (const check of report.checks) {
      expect(typeof check.id).toBe("string");
      expect(check.id.length).toBeGreaterThan(0);
      expect(typeof check.label).toBe("string");
      expect(check.label.length).toBeGreaterThan(0);
      expect(["ok", "warn", "error"]).toContain(check.status);
      expect(typeof check.detail).toBe("string");
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  it("includes expected check IDs", async () => {
    const report = await runDoctorChecks();
    const ids = report.checks.map((c) => c.id);

    // Provider checks
    expect(ids).toContain("provider.claude.binary");
    expect(ids).toContain("provider.claude.version");
    expect(ids).toContain("provider.codex.binary");
    expect(ids).toContain("provider.codex.version");
    expect(ids).toContain("provider.opencode.binary");
    expect(ids).toContain("provider.opencode.version");

    // Config checks
    expect(ids).toContain("config.valid");
    expect(ids).toContain("config.listen");

    // Runtime checks
    expect(ids).toContain("runtime.node");
    expect(ids).toContain("runtime.paseo");
  });

  it("runtime.node reports the current Node version", async () => {
    const report = await runDoctorChecks();
    const nodeCheck = report.checks.find((c) => c.id === "runtime.node");

    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe("ok");
    expect(nodeCheck!.detail).toBe(process.version);
  });

  it("accepts a custom version option", async () => {
    const report = await runDoctorChecks({ version: "1.2.3-test" });
    const paseoCheck = report.checks.find((c) => c.id === "runtime.paseo");

    expect(paseoCheck).toBeDefined();
    expect(paseoCheck!.status).toBe("ok");
    expect(paseoCheck!.detail).toBe("1.2.3-test");
  });
});
