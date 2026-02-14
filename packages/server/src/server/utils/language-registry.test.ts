import { describe, expect, it } from "vitest";
import {
  getSupportedLanguageExtensions,
  isGrammarBackedLanguage,
  isKnownTextFilename,
  resolveLanguageEntry,
} from "./language-registry.js";

describe("language-registry", () => {
  it("resolves extension collisions deterministically", () => {
    expect(resolveLanguageEntry("example.h")?.id).toBe("cpp");
    expect(resolveLanguageEntry("example.m")?.id).toBe("objective-c");
  });

  it("keeps dockerfile classified as text without requiring a grammar", () => {
    expect(isKnownTextFilename("Dockerfile")).toBe(true);
    expect(isGrammarBackedLanguage("Dockerfile")).toBe(false);
  });

  it("keeps xml and graphql text-classified when grammar loading is unavailable", () => {
    expect(isKnownTextFilename("schema.xml")).toBe(true);
    expect(isKnownTextFilename("query.graphql")).toBe(true);
    expect(isGrammarBackedLanguage("schema.xml")).toBe(false);
    expect(isGrammarBackedLanguage("query.graphql")).toBe(false);
  });

  it("returns grammar-backed extensions for syntax highlighting", () => {
    const supported = getSupportedLanguageExtensions();
    expect(supported).toContain(".ts");
    expect(supported).toContain(".tsx");
    expect(supported).not.toContain(".dockerfile");
  });
});
