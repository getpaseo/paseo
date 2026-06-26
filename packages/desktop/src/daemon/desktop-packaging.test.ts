import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

describe("desktop packaging", () => {
  it("unpacks server zsh shell integration files for external shells", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain(
      "node_modules/@getpaseo/server/dist/server/terminal/shell-integration/**/*",
    );
    expect(config).not.toContain(
      "node_modules/@getpaseo/server/dist/src/terminal/shell-integration/**/*",
    );
  });

  it("excludes package debug/source files from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!**/*.map");
    expect(config).toContain("!node_modules/@getpaseo/*/src/**");
    expect(config).toContain("!node_modules/@getpaseo/**/*.test.*");
    expect(config).toContain("!node_modules/@getpaseo/**/*.spec.*");
  });

  it("excludes the bundled daemon web UI from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!node_modules/@getpaseo/server/dist/server/web-ui/**");
  });

  // electron-builder packs production dependencies declared in package.json into
  // app.asar. Runtime code in runtime-paths.ts and bin/paseo dynamically resolves
  // these workspace packages by string, so static analysis (TypeScript, Knip) cannot
  // see the link. If a runtime-required workspace dep is dropped from
  // dependencies, the build still succeeds but ships a broken bundle. This
  // assertion is the safety net.
  it("declares all workspace packages required at runtime", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};

    for (const required of ["@getpaseo/cli", "@getpaseo/server"]) {
      expect(deps[required], `${required} must be declared in dependencies`).toBe("*");
    }
  });

  it("uses a console-subsystem executable for the bundled Windows CLI shim", () => {
    const cmd = readFileSync(join(packageRoot, "bin", "paseo.cmd"), "utf8");

    expect(cmd).toContain("PaseoCli.exe");
    expect(cmd).toContain('"%CLI_EXECUTABLE%"');
  });

  it("can mark the Windows CLI executable as console subsystem", () => {
    const { setWindowsExecutableSubsystem } = require(
      join(packageRoot, "scripts", "after-pack.js"),
    ) as {
      setWindowsExecutableSubsystem: (filePath: string, subsystem: number) => void;
    };
    const tempDir = mkdtempSync(join(tmpdir(), "paseo-pe-subsystem-"));
    const exePath = join(tempDir, "probe.exe");
    const peHeaderOffset = 0x80;
    const subsystemOffset = peHeaderOffset + 0x5c;
    const bytes = Buffer.alloc(subsystemOffset + 2);
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(peHeaderOffset, 0x3c);
    bytes.write("PE\u0000\u0000", peHeaderOffset, "ascii");
    bytes.writeUInt16LE(2, subsystemOffset);
    writeFileSync(exePath, bytes);

    try {
      setWindowsExecutableSubsystem(exePath, 3);

      const patched = readFileSync(exePath);
      expect(patched.readUInt16LE(subsystemOffset)).toBe(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
