// Terminal output covering the scripts and styles the native renderer must place on the grid.
// Each entry is one line of output; `ruler` is drawn with full blocks so the harness can read
// the grid origin and cell width from pixels, independent of the renderer under test.

const ESC = "\u001b";
const sgr = (codes, text) => `${ESC}[${codes}m${text}${ESC}[0m`;

export const RULER_CELLS = 20;
/** A foreground no theme uses, so its pixels can be told apart from default text. */
export const ACCENT = [255, 64, 160];
const accent = (text) => sgr(`38;2;${ACCENT.join(";")}`, text);
/**
 * The `select` line starts with a conjunct whose first cell the harness selects on its own. Its
 * second cell uses the accent, which no theme's selection foreground matches.
 */
export const SELECT_LINE = "select";

export function fixtureLines(columns) {
  const wrapSyllables = Math.ceil(columns / 2) + 6;
  return [
    { name: "ruler", text: "█".repeat(RULER_CELLS) },
    { name: "ascii", text: "ASCII abcdefghij 0123456789 end" },
    { name: "hangul-mixed", text: "한글 문장 Hello end" },
    { name: "hangul-color-boundary", text: `안녕하세요${sgr(31, "NEXT")} end` },
    { name: "hangul-bold-boundary", text: `${sgr(1, "안녕하세요")}NEXT end` },
    { name: "hangul-decomposed", text: "한글 end" },
    { name: "cjk", text: "日本語テキスト 中文字符 end" },
    { name: "combining", text: "é ä ñ x̣̂ end" },
    { name: "arabic", text: "مرحبا لا 123 abc end" },
    { name: "devanagari", text: "नमस्ते क्षत्रिय end" },
    { name: "emoji", text: "👍 ❤️ 👋🏽 👩‍💻 🇰🇷 end" },
    // One shaped cluster over two cells, colored per cell: the color must follow the cell.
    { name: "split-color", text: `क्${accent("ष")} ${accent("क्")}ष ल${accent("ا")} end` },
    { name: SELECT_LINE, text: `क्${accent("ष")} end` },
    { name: "box", text: "╭──┬──╮ │ab│cd│ ╰──┴──╯ ▀▄▌▐░▒▓ end" },
    {
      name: "styles",
      text: [
        sgr(1, "bold"),
        sgr(3, "italic"),
        sgr(4, "under"),
        sgr(7, "inverse"),
        sgr(42, "bg"),
        sgr(9, "strike"),
        "end",
      ].join(" "),
    },
    { name: "hangul-wrap", text: "가".repeat(wrapSyllables) },
    // The last line has no newline: the shell sleeps with the cursor right after it.
    { name: "cursor", text: "> 안녕하세요" },
  ];
}

/** The bytes `cat` writes; the tty turns each newline into CR LF. */
export function fixtureOutput(columns) {
  return fixtureLines(columns)
    .map((line) => line.text)
    .join("\n");
}
