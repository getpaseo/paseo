import { describe, expect, it } from "vitest";
import { pluginMediaKind } from "./plugin-registry.js";

describe("plugin media kind", () => {
  it.each([
    ["https://cdn.example.com/a/preview.png", "image"],
    ["https://cdn.example.com/a/preview.JPG", "image"],
    ["https://cdn.example.com/a/preview.jpeg", "image"],
    ["https://cdn.example.com/a/preview.webp", "image"],
    ["https://cdn.example.com/a/preview.gif", "image"],
    ["https://cdn.example.com/a/demo.mp4", "video"],
    ["https://cdn.example.com/a/demo.WebM", "video"],
    ["https://cdn.example.com/a/demo.mp4?raw=true#t=2", "video"],
    ["https://cdn.example.com/mp4/preview.png?format=mp4", "image"],
  ] as const)("reads %s as %s from its path extension", (url, kind) => {
    expect(pluginMediaKind(url)).toBe(kind);
  });
});
