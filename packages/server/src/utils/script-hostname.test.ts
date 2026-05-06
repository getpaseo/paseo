import { describe, expect, it } from "vitest";
import { buildScriptHostname } from "./script-hostname.js";

describe("buildScriptHostname", () => {
  it("builds default branch hostnames with script and project labels", () => {
    expect(
      buildScriptHostname({
        projectSlug: "paseo",
        branchName: null,
        scriptName: "web",
      }),
    ).toBe("web.paseo.localhost");
  });

  it("omits the branch label for main and master", () => {
    expect(
      buildScriptHostname({
        projectSlug: "paseo",
        branchName: "main",
        scriptName: "web",
      }),
    ).toBe("web.paseo.localhost");
    expect(
      buildScriptHostname({
        projectSlug: "paseo",
        branchName: "master",
        scriptName: "web",
      }),
    ).toBe("web.paseo.localhost");
  });

  it("builds non-default branch hostnames with script, branch, and project labels", () => {
    expect(
      buildScriptHostname({
        projectSlug: "paseo",
        branchName: "feature-auth",
        scriptName: "web",
      }),
    ).toBe("web.feature-auth.paseo.localhost");
  });

  it("slugifies script, default branch project, and non-default branch labels", () => {
    expect(
      buildScriptHostname({
        projectSlug: "Paseo App",
        branchName: "Feature/Auth Flow",
        scriptName: "Web/API @ Dev",
      }),
    ).toBe("web-api-dev.feature-auth-flow.paseo-app.localhost");
  });

  it("accepts already slugified labels because slugify is idempotent", () => {
    expect(
      buildScriptHostname({
        projectSlug: "paseo-app",
        branchName: "feature-auth-flow",
        scriptName: "web-api-dev",
      }),
    ).toBe("web-api-dev.feature-auth-flow.paseo-app.localhost");
  });

  it("uses untitled as the hostname-label fallback when labels collapse to empty", () => {
    expect(
      buildScriptHostname({
        projectSlug: "日本語",
        branchName: "***",
        scriptName: "---",
      }),
    ).toBe("untitled.untitled.untitled.localhost");
  });
});
