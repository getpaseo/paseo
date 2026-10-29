import { describe, it, expect } from "vitest";
import { setImmediate } from "node:timers/promises";
import { highlightCodeWithBudget, HIGHLIGHT_MAX_SOURCE_BYTES } from "../budgeted-highlighter.js";
import type { HighlightToken } from "../types.js";
import { highlightCode, highlightCodeInSteps, highlightLine } from "../highlighter.js";

describe("highlightCode", () => {
  it("highlights JavaScript code with correct token styles", () => {
    const code = "const x = 42;";
    const result = highlightCode(code, "test.js");

    expect(result).toHaveLength(1);
    const tokens = result[0];
    expect(tokens.length).toBeGreaterThan(1);

    const keywordToken = tokens.find((t) => t.text === "const");
    expect(keywordToken?.style).toBe("keyword");

    const numberToken = tokens.find((t) => t.text === "42");
    expect(numberToken?.style).toBe("number");
  });

  it("highlights Python code", () => {
    const code = 'def hello():\n    print("world")';
    const result = highlightCode(code, "test.py");

    expect(result).toHaveLength(2);

    const defToken = result[0].find((t) => t.text === "def");
    expect(defToken?.style).toBe("keyword");

    const stringToken = result[1].find((t) => t.text.includes("world"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Swift code", () => {
    const code = 'struct Greeter {\n    let message = "hello"\n}';
    const result = highlightCode(code, "test.swift");

    expect(result).toHaveLength(3);

    const structToken = result[0].find((t) => t.text === "struct");
    expect(structToken?.style).toBe("keyword");

    const typeToken = result[0].find((t) => t.text === "Greeter");
    expect(typeToken?.style).toBe("definition");

    const stringToken = result[1].find((t) => t.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Dart code", () => {
    const code = 'class Greeter {\n  final String message = "hello";\n}';
    const result = highlightCode(code, "test.dart");

    expect(result).toHaveLength(3);

    const classToken = result[0].find((t) => t.text === "class");
    expect(classToken?.style).toBe("keyword");

    const finalToken = result[1].find((t) => t.text === "final");
    expect(finalToken?.style).toBe("keyword");

    const stringToken = result[1].find((t) => t.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights C# code", () => {
    const code = 'class Greeter {\n    string message = "hello";\n}';
    const result = highlightCode(code, "test.cs");

    expect(result).toHaveLength(3);

    const classToken = result[0].find((t) => t.text === "class");
    expect(classToken?.style).toBe("keyword");

    const stringToken = result[1].find((t) => t.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Nix code", () => {
    const code = 'let message = "hello"; in message';
    const result = highlightCode(code, "default.nix");

    const letToken = result[0].find((token) => token.text === "let");
    expect(letToken?.style).toBe("keyword");

    const stringToken = result[0].find((token) => token.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Svelte components across script, markup, and style", () => {
    const code = [
      '<script lang="ts">',
      "  let count: number = 1;",
      "</script>",
      "",
      "{#if count > 0}",
      '  <span class="badge">{count}</span>',
      "{/if}",
      "",
      "<style>",
      "  .badge {",
      "    color: red;",
      "  }",
      "</style>",
    ].join("\n");
    const result = highlightCode(code, "Counter.svelte");

    expect(result[1].find((t) => t.text === "let")?.style).toBe("keyword");
    expect(result[1].find((t) => t.text === "number")?.style).toBe("type");

    expect(result[4].find((t) => t.text === "if")?.style).toBe("keyword");
    expect(result[4].find((t) => t.text === "count")?.style).toBe("variable");

    expect(result[5].find((t) => t.text === "span")?.style).toBe("tag");
    expect(result[5].find((t) => t.text === "class")?.style).toBe("attribute");
    expect(result[5].find((t) => t.text === "count")?.style).toBe("variable");

    expect(result[9].find((t) => t.text === "badge")?.style).toBe("class");
    expect(result[10].find((t) => t.text === "color")?.style).toBe("property");
  });

  it("highlights Astro components across frontmatter, markup, and style", () => {
    const code = `---
const title = "Hello";
---
<main class="page">
  <h1>{title}</h1>
</main>
<style>
  .page { color: red; }
</style>`;

    const tokens = highlightCode(code, "Page.astro").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "const", style: "keyword" },
        { text: '"Hello"', style: "string" },
        { text: "main", style: "tag" },
        { text: "class", style: "attribute" },
        { text: "title", style: "variable" },
        { text: "page", style: "class" },
        { text: "color", style: "property" },
      ]),
    );
  });

  it("highlights Astro markup containing only an empty expression", () => {
    const code = "<p>{}</p>";

    const tokens = highlightCode(code, "Empty.astro").flat();

    expect(tokens.map((token) => token.text).join("")).toBe(code);
    expect(tokens).toContainEqual({ text: "p", style: "tag" });
  });

  it.each([
    "<p>{title} {} {title}</p>",
    '<p class="{} {title}">{title}</p>',
    "<p class={} title={title}>{title}</p>",
  ])("highlights Astro containing an empty expression: %s", (markup) => {
    const code = `---\nconst title = "Hello";\n---\n${markup}\n<style>.page { color: red; }</style>`;

    const lines = highlightCode(code, "Empty.astro");

    expect(lines).toHaveLength(code.split("\n").length);
    for (const [index, tokens] of lines.entries()) {
      expect(tokens.map((token) => token.text).join("")).toBe(code.split("\n")[index]);
    }
    expect(lines.flat()).toContainEqual({ text: "const", style: "keyword" });
    expect(lines.flat()).toContainEqual({ text: "p", style: "tag" });
    expect(lines.flat()).toContainEqual({ text: "color", style: "property" });
    expect(lines.flat()).toContainEqual({ text: "title", style: "variable" });
  });

  it("keeps an Astro expression open through nested template strings", () => {
    const code = "<p>{`a ${`}`} b`}</p>";

    const tokens = highlightCode(code, "Nested.astro").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "`}`", style: "string" },
        { text: " b`", style: "string" },
      ]),
    );
  });

  it("highlights Vue SFCs across script, template, and style", () => {
    const code = [
      '<script lang="ts">',
      "  let count: number = 1;",
      "</script>",
      "",
      "<template>",
      '  <p v-if="count > 0" :class="badge">{{ { count: 1 } }}</p>',
      "  <span>{{ 'a}}b' }} {{ { inner: 2 }}}</span>",
      "</template>",
      "",
      "<style>",
      "  .badge {",
      "    color: red;",
      "  }",
      "</style>",
    ].join("\n");

    const tokens = highlightCode(code, "Counter.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "let", style: "keyword" },
        { text: "number", style: "type" },
        { text: "template", style: "tag" },
        { text: "v-if", style: "attribute" },
        { text: "count", style: "definition" },
        { text: "1", style: "number" },
        { text: "'a}}b'", style: "string" },
        { text: "inner", style: "definition" },
        { text: "2", style: "number" },
        { text: "badge", style: "class" },
        { text: "color", style: "property" },
      ]),
    );
  });

  it("highlights a Vue SFC that contains an empty interpolation", () => {
    const code = ["<template>", "  <p>{{}} {{ count }}</p>", "</template>"].join("\n");

    const tokens = highlightCode(code, "Empty.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "template", style: "tag" },
        { text: "count", style: "variable" },
      ]),
    );
  });

  it("highlights quoted Vue directive values as code", () => {
    const code = "<template><p v-if=\"count > 0\" :class='badge'>x</p></template>";

    const tokens = highlightCode(code, "Directive.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "count", style: "variable" },
        { text: "0", style: "number" },
        { text: "badge", style: "variable" },
      ]),
    );
    expect(tokens).not.toContainEqual({ text: '"count > 0"', style: "string" });
  });

  it("keeps a Vue interpolation open through nested template strings", () => {
    const code = "<template><p>{{ `a ${`}}`} b` }}</p></template>";

    const tokens = highlightCode(code, "Nested.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "`}}`", style: "string" },
        { text: " b`", style: "string" },
      ]),
    );
  });

  it("highlights TSX code with correct dialect", () => {
    const code = 'const el = <div className="test">hello</div>;';
    const result = highlightCode(code, "test.tsx");

    expect(result).toHaveLength(1);
    const tokens = result[0];

    const constToken = tokens.find((t) => t.text === "const");
    expect(constToken?.style).toBe("keyword");

    const tagToken = tokens.find((t) => t.text === "div");
    expect(tagToken).toBeDefined();
  });

  it("returns unhighlighted tokens for unsupported extensions", () => {
    const code = "hello world\nsecond line";
    const result = highlightCode(code, "test.xyz");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([{ text: "hello world", style: null }]);
    expect(result[1]).toEqual([{ text: "second line", style: null }]);
  });

  it("splits multi-line code into separate line arrays", () => {
    const code = "line1\nline2\nline3";
    const result = highlightCode(code, "test.txt");

    expect(result).toHaveLength(3);
  });

  it("handles empty lines", () => {
    const code = "const a = 1;\n\nconst b = 2;";
    const result = highlightCode(code, "test.js");

    expect(result).toHaveLength(3);
    expect(result[1]).toEqual([{ text: "", style: null }]);
  });

  it("returns a single empty line for empty input", () => {
    expect(highlightCode("", "test.ts")).toEqual([[{ text: "", style: null }]]);
  });

  it("returns valid HighlightStyle values for all tokens", () => {
    const validStyles = new Set([
      "keyword",
      "comment",
      "string",
      "number",
      "literal",
      "function",
      "definition",
      "class",
      "type",
      "tag",
      "attribute",
      "property",
      "variable",
      "operator",
      "punctuation",
      "regexp",
      "escape",
      "meta",
      "heading",
      "link",
      null,
    ]);

    const code = '// comment\nconst x: number = 42;\nfunction foo() { return "bar"; }';
    const result = highlightCode(code, "test.ts");

    for (const line of result) {
      for (const token of line) {
        expect(validStyles.has(token.style)).toBe(true);
      }
    }
  });
});

describe("highlightCodeInSteps", () => {
  it("splits a large file into many bounded steps with the same result", () => {
    const code = Array.from(
      { length: 2000 },
      (_, index) => `/* block ${index}\n comment */ export const item${index} = "${index}";`,
    ).join("\n");
    const steps = highlightCodeInSteps(code, "large.ts");
    let count = 0;
    let step = steps.next();
    while (!step.done) {
      count++;
      step = steps.next();
    }

    expect(count).toBeGreaterThan(20);
    expect(step.value).toEqual(highlightCode(code, "large.ts"));
    expect(step.value[1]).toEqual([
      { text: " comment */", style: "comment" },
      { text: " ", style: null },
      { text: "export", style: "keyword" },
      { text: " ", style: null },
      { text: "const", style: "keyword" },
      { text: " ", style: null },
      { text: "item0", style: "definition" },
      { text: " ", style: null },
      { text: "=", style: "operator" },
      { text: " ", style: null },
      { text: '"0"', style: "string" },
      { text: ";", style: "punctuation" },
    ]);
  });

  it("highlights the first lines first, then the whole file", () => {
    const code = Array.from({ length: 1000 }, (_, index) => `const item${index} = ${index};`).join(
      "\n",
    );
    const full = highlightCode(code, "large.ts");
    const steps = highlightCodeInSteps(code, "large.ts", { firstLines: 100 });
    const progress: HighlightToken[][][] = [];
    let step = steps.next();
    while (!step.done) {
      if (step.value) progress.push(step.value);
      step = steps.next();
    }

    expect(progress).toHaveLength(1);
    expect(progress[0].slice(0, 100)).toEqual(full.slice(0, 100));
    expect(progress[0][100]).toEqual([{ text: "const item100 = 100;", style: null }]);
    expect(progress[0]).toHaveLength(1000);
    expect(step.value).toEqual(full);
  });

  it("highlights the whole file at once when the first lines are most of it", () => {
    const code = "const a = 1;\nconst b = 2;\nconst c = 3;";
    const steps = [...iterate(highlightCodeInSteps(code, "small.ts", { firstLines: 2 }))];
    expect(steps.filter(Boolean)).toEqual([]);
  });
});

function* iterate<T>(steps: Generator<T, unknown, void>): Generator<T> {
  for (let step = steps.next(); !step.done; step = steps.next()) yield step.value;
}

describe("highlightLine", () => {
  it("highlights a single line", () => {
    const tokens = highlightLine("const x = 1;", "test.js");

    expect(tokens.length).toBeGreaterThan(1);
    const keywordToken = tokens.find((t) => t.text === "const");
    expect(keywordToken?.style).toBe("keyword");
  });

  it("returns unhighlighted token for unsupported files", () => {
    const tokens = highlightLine("hello", "test.xyz");

    expect(tokens).toEqual([{ text: "hello", style: null }]);
  });
});

describe("highlightCodeWithBudget", () => {
  it("yields to IO while producing byte-identical output below the source budget", async () => {
    const code = "const value = Math.max(42, 7);\n".repeat(3_000);
    const expected = JSON.stringify(highlightCode(code, "file.ts"));
    let ticks = 0;
    let longestGap = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - lastTick);
      lastTick = now;
      ticks++;
    }, 1);
    try {
      const actual = await highlightCodeWithBudget(code, "file.ts", {
        yieldToEventLoop: setImmediate,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ticks).toBeGreaterThan(1);
      expect(longestGap).toBeLessThan(50);
      expect(JSON.stringify(actual)).toBe(expected);
    } finally {
      clearInterval(timer);
    }
  });

  it("budgets UTF-8 bytes before parsing, including multibyte text", async () => {
    expect(
      await highlightCodeWithBudget("é".repeat(HIGHLIGHT_MAX_SOURCE_BYTES / 2 + 1), "file.ts", {
        yieldToEventLoop: setImmediate,
      }),
    ).toBeNull();
    expect(
      await highlightCodeWithBudget("a".repeat(HIGHLIGHT_MAX_SOURCE_BYTES + 1), "file.ts", {
        yieldToEventLoop: setImmediate,
      }),
    ).toBeNull();
  });

  it("stops a parser that is cancelled between real event-loop turns", async () => {
    const controller = new AbortController();
    const pending = highlightCodeWithBudget(
      "const value = Math.max(42, 7);\n".repeat(3_000),
      "file.ts",
      { yieldToEventLoop: setImmediate, signal: controller.signal },
    );
    await setImmediate();
    controller.abort();
    expect(await pending).toBeNull();
  });
});
