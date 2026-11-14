import { parsePluginRegistryReference } from "./plugin-registry.js";
import { describe, expect, it } from "vitest";
import { parsePluginSourceReference, pluginInstallSource } from "./plugin-source-reference.js";

describe("plugin source references", () => {
  it.each([
    ".",
    "..",
    "./owner/slug",
    "../owner/slug",
    "/owner/slug",
    "~/owner/slug",
    "~",
    "C:\\",
    "C:/",
    "D:\\plugins\\repository",
    "D:/plugins/repository",
    "\\\\server\\share",
    "\\\\server\\share\\plugins\\review",
    ".\\plugins\\review",
    "..\\plugins\\review",
  ])("recognizes the explicit directory %s by shape", (source) => {
    expect(parsePluginSourceReference(source)).toEqual({
      kind: "directory",
      source,
      pluginPath: undefined,
    });
    expect(parsePluginSourceReference(`${source}:plugins/review`)).toEqual({
      kind: "directory",
      source,
      pluginPath: "plugins/review",
    });
  });

  it.each([
    ["npm:review@1.2.0:nested", "npm:review@1.2.0", "nested"],
    ["npm:review@^1.2.0", "npm:review@^1.2.0", undefined],
    ["npm:@team/review@next:plugins/main", "npm:@team/review@next", "plugins/main"],
    ["github:owner/repository", "github:owner/repository", undefined],
    [
      "git:git@example.test:owner/repository.git",
      "git:git@example.test:owner/repository.git",
      undefined,
    ],
    ["git:file:///repo:plugins/main", "git:file:///repo", "plugins/main"],
    ["plugins.example.com:8443/owner/slug", "plugins.example.com:8443/owner/slug", undefined],
    ["owner/repository", "owner/repository", undefined],
    ["plugins/foo", "plugins/foo", undefined],
    ["owner/repository:plugins/review", "owner/repository", "plugins/review"],
    [
      "https://example.test:8443/owner/repository.git",
      "https://example.test:8443/owner/repository.git",
      undefined,
    ],
    [
      "https://example.test:8443/owner/repository.git:plugins/review",
      "https://example.test:8443/owner/repository.git",
      "plugins/review",
    ],
    ["git@example.test:owner/repository.git", "git@example.test:owner/repository.git", undefined],
    [
      "git@example.test:owner/repository.git:plugins/review",
      "git@example.test:owner/repository.git",
      "plugins/review",
    ],
    ["file:///D:/plugins/repository", "file:///D:/plugins/repository", undefined],
    [
      "file:///D:/plugins/repository:plugins/review",
      "file:///D:/plugins/repository",
      "plugins/review",
    ],
  ])("parses %s", (reference, source, pluginPath) => {
    expect(parsePluginSourceReference(reference)).toEqual({ kind: "managed", source, pluginPath });
  });
});

it("addresses default and private registries without treating explicit sources as registry IDs", () => {
  expect(parsePluginRegistryReference("omercnet/dracula")).toEqual({
    url: "https://plugins.paseo.sh",
    id: "omercnet/dracula",
  });
  expect(parsePluginRegistryReference("acme/plugin", "https://internal.example/registry/")).toEqual(
    { url: "https://internal.example/registry", id: "acme/plugin" },
  );
  expect(parsePluginRegistryReference("internal.example:8443/acme/plugin")).toEqual({
    url: "https://internal.example:8443",
    id: "acme/plugin",
  });
  expect(parsePluginRegistryReference("github:acme/plugin")).toBeNull();
  expect(parsePluginRegistryReference("npm:@acme/plugin")).toBeNull();
});

describe("plugin install sources", () => {
  it("pins a git installation to its commit and keeps the plugin path", () => {
    const install = pluginInstallSource(
      { kind: "git", remote: "https://example.test/acme/plugins.git", pluginPath: "review" },
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(install).toEqual({
      source: "git:https://example.test/acme/plugins.git:review",
      ref: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(parsePluginSourceReference(install!.source)).toEqual({
      kind: "managed",
      source: "git:https://example.test/acme/plugins.git",
      pluginPath: "review",
    });
  });

  it("pins an npm installation to its version inside the source", () => {
    const install = pluginInstallSource(
      { kind: "npm", packageName: "@acme/review", pluginPath: "plugins/main" },
      "1.4.2",
    );
    expect(install).toEqual({ source: "npm:@acme/review@1.4.2:plugins/main" });
    expect(parsePluginSourceReference(install!.source)).toEqual({
      kind: "managed",
      source: "npm:@acme/review@1.4.2",
      pluginPath: "plugins/main",
    });
  });

  it("addresses a registry installation by its host so the target's default registry does not matter", () => {
    const install = pluginInstallSource(
      {
        kind: "git",
        remote: "https://github.com/omercnet/dracula.git",
        pluginPath: ".",
        registry: { url: "https://plugins.paseo.sh", id: "omercnet/dracula" },
      },
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(install).toEqual({ source: "plugins.paseo.sh/omercnet/dracula" });
    expect(parsePluginRegistryReference(install!.source)).toEqual({
      url: "https://plugins.paseo.sh",
      id: "omercnet/dracula",
    });
  });

  it.each([
    [{ kind: "directory" as const, path: "/Users/me/plugins/review" }],
    [
      {
        kind: "npm" as const,
        packageName: "review",
        pluginPath: ".",
        registry: { url: "https://internal.example/registry", id: "acme/review" },
      },
    ],
    [
      {
        kind: "npm" as const,
        packageName: "review",
        pluginPath: ".",
        registry: { url: "http://internal.example", id: "acme/review" },
      },
    ],
  ])("returns null for an installation no source string can reproduce: %j", (identity) => {
    expect(pluginInstallSource(identity, "1.0.0")).toBeNull();
  });
});
