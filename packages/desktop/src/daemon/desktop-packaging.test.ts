import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("desktop packaging", () => {
  // TODO(port-paseo): paseo's electron-builder.yml unpacks shell-integration
  // files from @hubcode/server. Our fork doesn't bundle those — re-enable
  // when porting paseo's packaging changes.
  it.skip("unpacks server zsh shell integration files for external shells", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain(
      "node_modules/@hubcode/server/dist/server/terminal/shell-integration/**/*",
    );
    expect(config).not.toContain(
      "node_modules/@hubcode/server/dist/src/terminal/shell-integration/**/*",
    );
  });

  // electron-builder packs production dependencies declared in package.json into
  // app.asar. Runtime code in runtime-paths.ts and bin/hubcode dynamically resolves
  // these workspace packages by string, so static analysis (TypeScript, Knip) cannot
  // see the link. If a runtime-required workspace dep is dropped from
  // dependencies, the build still succeeds but ships a broken bundle. This
  // assertion is the safety net.
  it("declares all workspace packages required at runtime", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};

    // Fork pins workspace deps to the current version (kept in sync by
    // scripts/sync-workspace-versions.mjs). Paseo uses `*`. Accept any
    // declared version — only the presence matters for packaging.
    for (const required of ["@hubcode/cli", "@hubcode/server"]) {
      expect(deps[required], `${required} must be declared in dependencies`).toBeTruthy();
    }
  });
});
