import { describe, expect, it } from "vitest";
import { tokenizeToLines } from "@/utils/highlight-cache";
import { fenceLanguageToExtension } from "./highlighted-code-block";

describe("fenceLanguageToExtension", () => {
  it.each([
    ["shell", "sh"],
    ["ruby", "rb"],
    ["kotlin", "kt"],
    ["powershell", "ps1"],
    ["pwsh", "ps1"],
    ["protobuf", "proto"],
    ["latex", "tex"],
    ["stex", "tex"],
    ["diff", "diff"],
    ["patch", "patch"],
    ["sql", "sql"],
    ["lua", "lua"],
    ["proto", "proto"],
    ["groovy", "groovy"],
    ["gradle", "gradle"],
    ["scala", "scala"],
    ["cmake", "cmake"],
    ["properties", "properties"],
    ["ini", "ini"],
    ["conf", "conf"],
    ["r", "r"],
    ["perl", "pl"],
    ["toml", "toml"],
  ])("maps fence info %s to %s", (info, expected) => {
    expect(fenceLanguageToExtension(info)).toBe(expected);
  });

  it("produces syntax tokens for every mapped fence alias", () => {
    const samples: Array<[string, string]> = [
      ["shell", 'export FOO="bar"'],
      ["ruby", 'def hi\n  "ok"\nend'],
      ["kotlin", 'val x: String = "ok"'],
      ["powershell", 'function Get-X { "ok" }'],
      ["pwsh", '$x = "ok"'],
      ["protobuf", 'syntax = "proto3";'],
      ["latex", "\\documentclass{article}"],
      ["perl", 'my $x = "ok";'],
      ["sql", "SELECT 1;"],
      ["lua", "local x = 1"],
      ["gradle", 'id "java"'],
      ["scala", "val x = 1"],
      ["cmake", "project(Paseo)"],
      ["ini", "[section]\nkey = value"],
      ["r", "x <- function(a) a"],
      ["toml", '[server]\nhost = "localhost"'],
      ["diff", "+added"],
      ["patch", "-removed"],
    ];

    for (const [info, code] of samples) {
      const ext = fenceLanguageToExtension(info);
      const lines = tokenizeToLines(code, ext);
      expect(lines, info).not.toBeNull();
      expect(
        lines?.flat().some((token) => token.style !== null),
        info,
      ).toBe(true);
    }
  });
});
