import { describe, it, expect } from "vitest";
import {
  isLanguageSupported,
  getSupportedExtensions,
  getParserForFile,
  getLanguageForFile,
} from "../parsers.js";

describe("isLanguageSupported", () => {
  it("returns true for supported file extensions", () => {
    expect(isLanguageSupported("test.js")).toBe(true);
    expect(isLanguageSupported("test.ts")).toBe(true);
    expect(isLanguageSupported("test.tsx")).toBe(true);
    expect(isLanguageSupported("test.py")).toBe(true);
    expect(isLanguageSupported("test.go")).toBe(true);
    expect(isLanguageSupported("test.rs")).toBe(true);
    expect(isLanguageSupported("test.json")).toBe(true);
    expect(isLanguageSupported("test.css")).toBe(true);
    expect(isLanguageSupported("test.html")).toBe(true);
    expect(isLanguageSupported("test.java")).toBe(true);
    expect(isLanguageSupported("test.swift")).toBe(true);
    expect(isLanguageSupported("test.dart")).toBe(true);
    expect(isLanguageSupported("changes.diff")).toBe(true);
    expect(isLanguageSupported("bug.patch")).toBe(true);
    expect(isLanguageSupported("diff")).toBe(true);
    expect(isLanguageSupported("patch")).toBe(true);
    expect(isLanguageSupported("test.kt")).toBe(true);
    expect(isLanguageSupported("test.kts")).toBe(true);
    expect(isLanguageSupported("test.toml")).toBe(true);
    expect(isLanguageSupported("test.cs")).toBe(true);
    expect(isLanguageSupported("test.nix")).toBe(true);
    expect(isLanguageSupported("main.tf")).toBe(true);
    expect(isLanguageSupported("prod.tfvars")).toBe(true);
    expect(isLanguageSupported("terragrunt.hcl")).toBe(true);
    expect(isLanguageSupported("test.rb")).toBe(true);
    expect(isLanguageSupported("tasks.rake")).toBe(true);
    expect(isLanguageSupported("paseo.gemspec")).toBe(true);
    expect(isLanguageSupported("config.ru")).toBe(true);
    expect(isLanguageSupported("query.sql")).toBe(true);
    expect(isLanguageSupported("script.lua")).toBe(true);
    expect(isLanguageSupported("schema.proto")).toBe(true);
    expect(isLanguageSupported("deploy.ps1")).toBe(true);
    expect(isLanguageSupported("module.psm1")).toBe(true);
    expect(isLanguageSupported("manifest.psd1")).toBe(true);
    expect(isLanguageSupported("build.groovy")).toBe(true);
    expect(isLanguageSupported("build.gradle")).toBe(true);
    expect(isLanguageSupported("Main.scala")).toBe(true);
    expect(isLanguageSupported("script.sc")).toBe(true);
    expect(isLanguageSupported("toolchain.cmake")).toBe(true);
    expect(isLanguageSupported("app.properties")).toBe(true);
    expect(isLanguageSupported("config.ini")).toBe(true);
    expect(isLanguageSupported("service.conf")).toBe(true);
    expect(isLanguageSupported("analysis.r")).toBe(true);
    expect(isLanguageSupported("analysis.R")).toBe(true);
    expect(isLanguageSupported("script.pl")).toBe(true);
    expect(isLanguageSupported("Module.pm")).toBe(true);
    expect(isLanguageSupported("paper.tex")).toBe(true);
    expect(isLanguageSupported("style.sty")).toBe(true);
    expect(isLanguageSupported("article.cls")).toBe(true);
    expect(isLanguageSupported("test.ex")).toBe(true);
    expect(isLanguageSupported("Counter.svelte")).toBe(true);
    expect(isLanguageSupported("Page.astro")).toBe(true);
    expect(isLanguageSupported("App.vue")).toBe(true);
  });

  it("returns false for unsupported file extensions", () => {
    expect(isLanguageSupported("test.xyz")).toBe(false);
    expect(isLanguageSupported("test.txt")).toBe(false);
    expect(isLanguageSupported("test.csv")).toBe(false);
  });

  it("returns false for files without extensions", () => {
    expect(isLanguageSupported("Makefile")).toBe(false);
    expect(isLanguageSupported("src/ts")).toBe(false);
    expect(isLanguageSupported("bin/bash")).toBe(false);
  });

  it("recognizes Ruby files identified by their whole name", () => {
    for (const name of ["Gemfile", "Rakefile", "Guardfile", "Capfile", "Podfile", "Vagrantfile"]) {
      expect(isLanguageSupported(name)).toBe(true);
      expect(isLanguageSupported(`app/${name}`)).toBe(true);
      expect(isLanguageSupported(`dir.with.dots/${name}`)).toBe(true);
    }
    expect(getLanguageForFile("Gemfile")).toBe(getLanguageForFile("app.rb"));
    // Names are case-sensitive, and a lockfile is not Ruby.
    expect(isLanguageSupported("gemfile")).toBe(false);
    expect(isLanguageSupported("Gemfile.lock")).toBe(false);
  });

  it("recognizes CMakeLists.txt by exact basename", () => {
    expect(isLanguageSupported("CMakeLists.txt")).toBe(true);
    expect(isLanguageSupported("app/CMakeLists.txt")).toBe(true);
    expect(isLanguageSupported("dir.with.dots/CMakeLists.txt")).toBe(true);
    expect(getLanguageForFile("CMakeLists.txt")).toBe(getLanguageForFile("toolchain.cmake"));
    expect(isLanguageSupported("cmakelists.txt")).toBe(false);
  });

  it("handles nested paths", () => {
    expect(isLanguageSupported("src/utils/test.ts")).toBe(true);
    expect(isLanguageSupported("deep/nested/path/file.py")).toBe(true);
  });
});

describe("getSupportedExtensions", () => {
  it("returns an array of extension strings", () => {
    const extensions = getSupportedExtensions();

    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("includes common extensions", () => {
    const extensions = getSupportedExtensions();

    expect(extensions).toContain("js");
    expect(extensions).toContain("ts");
    expect(extensions).toContain("tsx");
    expect(extensions).toContain("py");
    expect(extensions).toContain("go");
    expect(extensions).toContain("rs");
    expect(extensions).toContain("swift");
    expect(extensions).toContain("dart");
    expect(extensions).toContain("diff");
    expect(extensions).toContain("patch");
    expect(extensions).toContain("kt");
    expect(extensions).toContain("kts");
    expect(extensions).toContain("toml");
    expect(extensions).toContain("cs");
    expect(extensions).toContain("nix");
    expect(extensions).toContain("tf");
    expect(extensions).toContain("tfvars");
    expect(extensions).toContain("hcl");
    expect(extensions).toContain("rb");
    expect(extensions).toContain("rake");
    expect(extensions).toContain("gemspec");
    expect(extensions).toContain("ru");
    expect(extensions).toContain("sql");
    expect(extensions).toContain("lua");
    expect(extensions).toContain("proto");
    expect(extensions).toContain("ps1");
    expect(extensions).toContain("psm1");
    expect(extensions).toContain("psd1");
    expect(extensions).toContain("groovy");
    expect(extensions).toContain("gradle");
    expect(extensions).toContain("scala");
    expect(extensions).toContain("sc");
    expect(extensions).toContain("cmake");
    expect(extensions).toContain("properties");
    expect(extensions).toContain("ini");
    expect(extensions).toContain("conf");
    expect(extensions).toContain("r");
    expect(extensions).toContain("pl");
    expect(extensions).toContain("pm");
    expect(extensions).toContain("tex");
    expect(extensions).toContain("sty");
    expect(extensions).toContain("cls");
    expect(extensions).toContain("json");
    expect(extensions).toContain("svelte");
    expect(extensions).toContain("astro");
    expect(extensions).toContain("vue");
  });
});

describe("getParserForFile", () => {
  it("projects the parser retained by the editor language registry", () => {
    for (const extension of getSupportedExtensions()) {
      const filename = `source.${extension}`;
      expect(getParserForFile(filename)).toBe(getLanguageForFile(filename)?.parser);
    }
  });

  it("returns a parser for supported files", () => {
    expect(getParserForFile("test.js")).not.toBeNull();
    expect(getParserForFile("test.py")).not.toBeNull();
  });

  it("returns null for unsupported files", () => {
    expect(getParserForFile("test.xyz")).toBeNull();
  });

  it("returns null for files without extension", () => {
    expect(getParserForFile("noext")).toBeNull();
  });

  it("is case-insensitive for extensions", () => {
    expect(getParserForFile("test.JS")).not.toBeNull();
    expect(getParserForFile("test.Py")).not.toBeNull();
  });
});
