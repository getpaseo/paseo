import { describe, expect, it } from "vitest";
import { scanMath } from "./math";

interface MathEntry {
  content: string;
  display: boolean;
}

// Ground truth comes from the library md4c WASM parser: for each source the
// expected list is the ordered math node content it produces. md4c joins
// span lines with single spaces, so the raw slice needs the same treatment.
const normalize = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ");

const cases: Array<[string, string, MathEntry[]]> = [
  ["inline-basics", "The cost is $x^2$ when x is large.", [{ content: "x^2", display: false }]],
  [
    "display-oneline",
    "Before.\n\n$$E = mc^2$$\n\nAfter.",
    [{ content: "E = mc^2", display: true }],
  ],
  ["display-blank-inside", "para\n\n$$\na=b\n\nc=d\n$$\nend", []],
  [
    "display-multiline",
    "para\n\n$$\na=b\n c=d\n$$\nend",
    [{ content: " a=b c=d ", display: true }],
  ],
  ["inline-across-blank", "$a\n\nb$", []],
  ["inline-softbreak", "$a\nb$", [{ content: "a b", display: false }]],
  ["prices", "It costs $5 and $10, or $2,000 total.", []],
  ["codespans", "Set `a$b` and `$HOME` for the build.", []],
  ["indented", "  $x$", [{ content: "x", display: false }]],
  ["consecutive", "$$a$$b$$c", []],
  ["html-in-inline-math", "Costs $x<y>z$ today", [{ content: "x<y>z", display: false }]],
  ["punct-adjacent", "The result is ($x^2$) exactly.", [{ content: "x^2", display: false }]],
  [
    "two-inlines",
    "a $x$ b $y$ c",
    [
      { content: "x", display: false },
      { content: "y", display: false },
    ],
  ],
  ["three-dollars", "$$$x$$$", []],
  ["inline-in-display", "para\n\n$$ $x$ $$\nend", [{ content: "x", display: false }]],
  ["display-blank-pair", "para\n\n$$ a\n\nb $$\nend", []],
  ["eof-no-newline", "$x$", [{ content: "x", display: false }]],
  ["space-before-closer", "$x $", [{ content: "x ", display: false }]],
  ["unclosed-display", "para\n\n$$a", []],
  ["math-in-emphasis", "**bold $x$**", [{ content: "x", display: false }]],
  ["fence", "before\n\n```\n$a$b and $$c$$\n```\n\nafter $x$", [{ content: "x", display: false }]],
  ["fence-tilde", "~~~\n$$a$$\n~~~\ntext $y$", [{ content: "y", display: false }]],
  ["htmlblock", "<div>$x$</div>\ntext $y$", []],
  [
    "htmlblock-multiline",
    "<div>\n$a$b and <y>$c$\n</div>\n\ntext $y$",
    [{ content: "y", display: false }],
  ],
  ["escape-in-math", "$a\\$b", []],
  ["escaped-dollar", "Costs \\$5 not math", []],
  ["dollar-after-letter", "abc$def$", []],
  ["display-adjacent-text", "$$x$$tail", []],
  ["display-adjacent-text2", "head$$x$$", []],
  ["inline-in-code-in-math", "$`x`$", [{ content: "`x`", display: false }]],
  ["nested-attempt", "$a $b$ c$", [{ content: "b", display: false }]],
  ["openers-only", "$$ a $$b", []],
  ["stack-clear", "$$ a $b$ c", [{ content: "b", display: false }]],
  ["heading-math", "# $x$ heading", [{ content: "x", display: false }]],
  [
    "table-math",
    "| $x$ |\n| --- |\n| $y$ |",
    [
      { content: "x", display: false },
      { content: "y", display: false },
    ],
  ],
  [
    "blockquote",
    "> quote $x$ more\n> next $y$",
    [
      { content: "x", display: false },
      { content: "y", display: false },
    ],
  ],
  [
    "list-item",
    "- item $x$ more\n- next $y$",
    [
      { content: "x", display: false },
      { content: "y", display: false },
    ],
  ],
  [
    "ordered-list",
    "1. first $x$\n2. second $y$",
    [
      { content: "x", display: false },
      { content: "y", display: false },
    ],
  ],
  [
    "setext",
    "Title $x$\n===\ntext $y$",
    [
      { content: "x", display: false },
      { content: "y", display: false },
    ],
  ],
  [
    "indented-code",
    "para\n\n    $a$ code\n    $$b$$ code\n\ntext $y$",
    [{ content: "y", display: false }],
  ],
  ["lazy-continuation", "para line one\n    $x$ indented lazy", [{ content: "x", display: false }]],
  [
    "crlf",
    "line $x$ one\r\nmore $$y$$ two\r\n",
    [
      { content: "x", display: false },
      { content: "y", display: true },
    ],
  ],
  ["comment-in-math", "a <!-- c --> $x$ b", [{ content: "x", display: false }]],
  ["comment-span", "$a<!-- c -->b$", [{ content: "a<!-- c -->b", display: false }]],
  ["autolink-lookalike", "<$x$> not an autolink", [{ content: "x", display: false }]],
  ["hr", "top $a$\n<hr>\nbottom $b$", [{ content: "a", display: false }]],
  ["hr-attrs", 'top $a$\n<hr class="x">\nbottom $b$', [{ content: "a", display: false }]],
  ["hr-selfclose", "top $a$\n<hr/>\nbottom $b$", [{ content: "a", display: false }]],
  [
    "hr-blank",
    "top $a$\n<hr>\n\nbottom $b$",
    [
      { content: "a", display: false },
      { content: "b", display: false },
    ],
  ],
  ["fence-unclosed", "intro\n\n```\n$$open\nstill code $x$", []],
  [
    "fence-indented",
    "   ```\n   $a$ in fence\n   ```\nafter $b$",
    [{ content: "b", display: false }],
  ],
  ["display-two-pending", "p\n\n$$ a $$b\n\nmore $c$", [{ content: "c", display: false }]],
  ["unclosed-then-close-same-para", "p\n\n$$ a\nb $c$ d", [{ content: "c", display: false }]],
  ["dollar-eol-next-line", "$a\nb$", [{ content: "a b", display: false }]],
  ["punct-before", "(start $x$ end)", [{ content: "x", display: false }]],
  [
    "unicode-punct",
    "«$x$» and —$y$—",
    [
      { content: "x", display: false },
      { content: "y", display: false },
    ],
  ],
  ["nbsp-before", " $x$ after nbsp", [{ content: "x", display: false }]],
  ["tag-with-dollars", "<div$x$> weird", []],
  ["code-span-multi-line", "text `a\n$b` tail $y$", [{ content: "y", display: false }]],
  [
    "hr-after-para-para",
    "top $a$\n<br>\nbottom $b$",
    [
      { content: "a", display: false },
      { content: "b", display: false },
    ],
  ],
];

describe("scanMath mirrors the md4c LATEXMATHSPANS delimiters", () => {
  for (const [name, source, expected] of cases) {
    it(name, () => {
      const actual = scanMath(source).spans.map((span) => ({
        content: normalize(
          source.slice(span.start + (span.display ? 2 : 1), span.end - (span.display ? 2 : 1)),
        ),
        display: span.display,
      }));
      expect(actual).toEqual(expected);
    });
  }
});

describe("scanMath pending openers", () => {
  const pendingCases: Array<[string, string, Array<[number, boolean]>]> = [
    ["open display", "para\n\n$$ a", [[6, true]]],
    [
      "two pending displays",
      "$$ a $$b",
      [
        [0, true],
        [5, true],
      ],
    ],
    ["an inline match clears every pending opener", "$$ a $b$ c", []],
    ["open inline", "a $x", [[2, false]]],
    ["fence hides the opener", "intro\n\n```\n$$open\n", []],
    ["indented code hides the opener", "p\n\n    $$ code", []],
    ["html block hides the opener", "<div>\n$$x", []],
    ["closed then open", "$$a$$ then $$b", [[11, true]]],
    ["open across a line break", "p\n\n$$\n a", [[3, true]]],
    [
      "mismatched display then inline",
      "$$ a $x",
      [
        [0, true],
        [5, false],
      ],
    ],
  ];
  for (const [name, source, expected] of pendingCases) {
    it(name, () => {
      const actual = scanMath(source).pending.map(
        (opener) => [opener.start, opener.display] as [number, boolean],
      );
      expect(actual).toEqual(expected);
    });
  }
});
