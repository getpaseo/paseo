import { describe, expect, test } from "vitest";
import path from "node:path";

import { resolveSherpaLoaderEnv } from "./sherpa-runtime-env.js";

const resources = path.join(path.parse(process.cwd()).root, "Paseo", "resources");

function packageJsonUnder(...segments: string[]): string {
  return path.join(resources, ...segments, "sherpa-onnx-win-x64", "package.json");
}

describe("resolveSherpaLoaderEnv", () => {
  test("points at app.asar.unpacked when the package resolves inside app.asar", () => {
    // Electron resolves packaged modules to paths inside the app.asar archive file.
    // The OS loader and non-Electron processes cannot use a directory inside a file.
    const resolved = resolveSherpaLoaderEnv("win32", "x64", () =>
      packageJsonUnder("app.asar", "node_modules"),
    );

    expect(resolved?.libDir).toBe(
      path.join(resources, "app.asar.unpacked", "node_modules", "sherpa-onnx-win-x64"),
    );
  });

  test("keeps a path that is already unpacked", () => {
    const resolved = resolveSherpaLoaderEnv("win32", "x64", () =>
      packageJsonUnder("app.asar.unpacked", "node_modules"),
    );

    expect(resolved?.libDir).toBe(
      path.join(resources, "app.asar.unpacked", "node_modules", "sherpa-onnx-win-x64"),
    );
  });

  test("keeps a path outside any asar archive", () => {
    const resolved = resolveSherpaLoaderEnv("win32", "x64", () =>
      packageJsonUnder("my-app.asar-cache", "node_modules"),
    );

    expect(resolved?.libDir).toBe(
      path.join(resources, "my-app.asar-cache", "node_modules", "sherpa-onnx-win-x64"),
    );
  });

  test("returns null when the platform package is not installed", () => {
    const resolved = resolveSherpaLoaderEnv("win32", "x64", () => {
      throw new Error("Cannot find module");
    });

    expect(resolved).toBeNull();
  });
});
