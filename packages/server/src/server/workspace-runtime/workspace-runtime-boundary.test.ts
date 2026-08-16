import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

test("core owns only generic command runtime registration", () => {
  for (const packagePath of [
    "packages/cli/package.json",
    "packages/desktop/package.json",
    "packages/server/package.json",
  ]) {
    const manifest = packageJson(packagePath);
    expect(manifest.dependencies, packagePath).not.toHaveProperty(
      "@getpaseo/docker-workspace-runtime",
    );
    expect(manifest.dependencies, packagePath).not.toHaveProperty(
      "@getpaseo/srt-workspace-runtime",
    );
    expect(JSON.stringify(manifest.files ?? []), packagePath).not.toMatch(
      /(?:docker|srt)-workspace-runtime|runtimes\/(?:docker|srt)/u,
    );
  }

  const rootPackage = packageJson("package.json");
  expect(rootPackage.scripts?.["build:server-deps"]).not.toContain("docker-workspace-runtime");
  expect(rootPackage.scripts?.["build:server-deps:clean"]).not.toContain(
    "docker-workspace-runtime",
  );

  for (const relativePath of [
    "packages/server/src/server/workspace-runtime/index.ts",
    "packages/server/src/server/persisted-config.ts",
    "packages/server/src/server/bootstrap.ts",
    "packages/app/src/new-workspace-runtime/model.ts",
  ]) {
    const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    expect(source, relativePath).not.toContain("@getpaseo/docker-workspace-runtime");
    expect(source, relativePath).not.toMatch(/type:\s*["']docker["']/u);
  }
});

test("production composition and release artifacts exclude runtime implementations", () => {
  for (const relativePath of [
    "packages/cli/src/commands/daemon/local-daemon.ts",
    "packages/desktop/src/daemon/daemon-manager.ts",
    "packages/desktop/electron-builder.yml",
    "docker/base/Dockerfile",
  ]) {
    expect(readFileSync(path.join(repositoryRoot, relativePath), "utf8"), relativePath).not.toMatch(
      /@getpaseo\/(?:docker|srt)-workspace-runtime|runtimes\/(?:docker|srt)/u,
    );
  }

  const rootPackage = packageJson("package.json");
  const releaseScripts = Object.entries(rootPackage.scripts ?? {})
    .filter(([name]) => name.startsWith("release:"))
    .map(([, command]) => command)
    .join("\n");
  expect(releaseScripts).not.toMatch(/(?:docker|srt)-workspace-runtime/u);

  const dockerfile = readFileSync(path.join(repositoryRoot, "docker/base/Dockerfile"), "utf8");
  expect(dockerfile).toContain(
    "npm pack --workspace=@getpaseo/workspace-runtime-contract --pack-destination /tmp/paseo-packs",
  );
  expect(dockerfile).toContain(
    "npm pack --workspace=@getpaseo/workspace-helper --pack-destination /tmp/paseo-packs",
  );
});

function packageJson(relativePath: string): {
  dependencies?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}
